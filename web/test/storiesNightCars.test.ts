// The night drive style's cars and props (CONTRACTS §45.45 §6): a car of the cast, a plain car, a truck and every
// other prop are drawn softer and in more detail in night drive, their own colours standing in the scene's light,
// and draw exactly as before in a classic script. The front and back views of the shots (carView.ts) draw every car
// boxy and slightly 3D, with glowing lights at night. Every budget here is the measured busiest frame, not a guess.
import { describe, expect, it } from "vitest";
import { grade, ink, LIGHTS, ND, withWarm, type Light } from "../src/stories/engine/art.ts";
import { CAR_CAST_SHAPES_ND, CAR_VIEW_SHAPES, checkCarLook, DEFAULT_CAR, type CarDraw } from "../src/stories/engine/car.ts";
import { drawCarView, drawPropView, plainCarLook, type CarViewOpts } from "../src/stories/engine/carView.ts";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { F, inFrame, withArt } from "../src/stories/engine/frame.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { BOX_ND, drawProp, plainColor, PROP_SHAPES_ND, propState } from "../src/stories/engine/props.ts";
import type { Beat, CarLook, Expression, Prim, PropAction, PropKind, SceneProp } from "../src/stories/engine/types.ts";

const CL = CATALOG.carLooks;
const ids = <T extends string>(list: { id: T }[]): T[] => list.map((e) => e.id);
const ALLOWED = new Set(["rect", "circle", "ellipse", "poly", "line", "grad"]);
const MOVERS = new Set<PropAction>(["move", "skid", "spin", "stop", "bump", "speed_up", "stall"]);
const ACTIONS: (PropAction | null)[] = [null, ...ids(CATALOG.propActions)];
const FRAME = { x0: -60, y0: -60, x1: 1140, y1: 1980 };
const NIGHT = withWarm(LIGHTS.night, 1);

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

function numbers(p: Prim): number[] {
  return Object.values(p).flatMap((v) => (typeof v === "number" ? [v] : Array.isArray(v) ? v.flat().filter((x): x is number => typeof x === "number") : []));
}

/** The box a prim covers (circles and ellipses by their larger radius, lines with their width). */
function extent(p: Prim): [number, number, number, number] | null {
  if (p.k === "circle") return [p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r];
  if (p.k === "ellipse") {
    const [rx, ry] = p.rot === 0 ? [p.rx, p.ry] : [Math.max(p.rx, p.ry), Math.max(p.rx, p.ry)];
    return [p.x - rx, p.y - ry, p.x + rx, p.y + ry];
  }
  if (p.k === "rect") return [p.x, p.y, p.x + p.w, p.y + p.h];
  if (p.k === "poly" || p.k === "line") {
    const w = p.k === "line" ? p.w / 2 : 0;
    const xs = p.pts.filter((_, j) => j % 2 === 0);
    const ys = p.pts.filter((_, j) => j % 2 === 1);
    return [Math.min(...xs) - w, Math.min(...ys) - w, Math.max(...xs) + w, Math.max(...ys) + w];
  }
  return null;
}

function problems(prims: Prim[], box: { x0: number; y0: number; x1: number; y1: number } | null): string[] {
  const out: string[] = [];
  for (const [i, p] of prims.entries()) {
    if (!ALLOWED.has(p.k)) out.push(`${i}: ${p.k} is not a car shape`);
    if (numbers(p).some((v) => !Number.isFinite(v))) out.push(`${i}: ${p.k} has a NaN`);
    const e = box ? extent(p) : null;
    if (box && e && (e[0] < box.x0 || e[1] < box.y0 || e[2] > box.x1 || e[3] > box.y1)) out.push(`${i}: ${p.k} reaches outside the box (${e.map((v) => Math.round(v)).join(", ")})`);
  }
  return out;
}

const alphaOf = (p: Prim): number => ("a" in p && typeof p.a === "number" ? p.a : 1);
const colours = (prims: Prim[]): Set<string> => new Set(prims.flatMap((p) => ("color" in p ? [p.color] : [])));

/** Runs fn in a night drive 1080 × 1920 script, in a light. */
function nd<T>(light: Readonly<Light>, fn: () => T): T {
  return inFrame({ width: 1080, height: 1920, art: "night_drive" }, () => {
    F.light = light;
    return fn();
  });
}

const castCar = (extra: Partial<SceneProp> = {}): SceneProp => ({ propId: "rosso", kind: "car", x: 0.5, y: 0.72, scale: 0.8, rot: 0, castId: "c2", ...extra });

/** One prop's prims at time t of a single prop action (or none), in a view, in whatever style and light is set. */
function propPrims(prop: SceneProp, view: "side" | "top", act: PropAction | null, t: number, opts: { car?: CarLook; night?: boolean; face?: Expression; pen?: Pen } = {}): Prim[] {
  const beats: Beat[] = act ? [{ at: 0.2, dur: 1.6, who: prop.propId, do: act, dir: "right", ...(MOVERS.has(act) ? { to: { x: 0.62, y: 0.7 } } : {}), ...(opts.face ? { face: opts.face } : {}) }] : [];
  const d: CarDraw | null = opts.car ? { car: opts.car, style: "bouncy", seed: 11 } : null;
  const st = propState(prop, beats, view, t, { braking: 0, steer: 0, rolled: t * 300 }, d);
  if (!act && d) st.face = opts.face ?? null;
  const pen = opts.pen ?? new Pen();
  drawProp(pen, st, view, t, 3, {}, opts.night ?? false, d);
  return pen.out;
}

const OTHER_KINDS = ids(CATALOG.props).filter((k) => k !== "car" && k !== "truck" && k !== "snow" && k !== "rain" && k !== "fog");

describe("a classic script draws exactly as before", () => {
  it("cars of the cast, plain cars, trucks and every other prop draw the same prims with no style, in classic and in any light", () => {
    const kinds: PropKind[] = ["car", "truck", ...OTHER_KINDS];
    for (const kind of kinds) {
      for (const view of ["side", "top"] as const) {
        for (const act of ["move", "honk", "stop", "tyre_burst", "blink", null] as (PropAction | null)[]) {
          const prop: SceneProp = { propId: "p", kind, x: 0.5, y: 0.7, scale: 1, rot: 0 };
          const car = kind === "car" ? looks(true)[1]! : undefined;
          const plain = propPrims(prop, view, act, 0.7, { night: true });
          const cast = car ? propPrims(castCar(), view, act, 0.7, { car, night: true, face: "happy" }) : null;
          for (const run of [
            <T>(fn: () => T) => withArt("classic", fn),
            <T>(fn: () => T) => inFrame({ width: 1080, height: 1920 }, fn),
            <T>(fn: () => T) => inFrame({ width: 1080, height: 1920, art: "classic" }, () => ((F.light = NIGHT), fn())),
          ]) {
            expect(run(() => propPrims(prop, view, act, 0.7, { night: true })), `${kind} ${view} ${act}`).toEqual(plain);
            if (car) expect(run(() => propPrims(castCar(), view, act, 0.7, { car, night: true, face: "happy" })), `cast ${view} ${act}`).toEqual(cast);
          }
          // and night drive changes the picture
          expect(nd(NIGHT, () => propPrims(prop, view, act, 0.7, { night: true })), `${kind} ${view} ${act} in night drive`).not.toEqual(plain);
        }
      }
    }
  });
});

describe("a car of the cast in night drive", () => {
  it(`every choice and every prop action draws with no NaN, in the allowed shapes, within CAR_CAST_SHAPES_ND (${CAR_CAST_SHAPES_ND}) prims`, () => {
    let busiest = 0;
    for (const light of [NIGHT, LIGHTS.day, LIGHTS.studio]) {
      for (const car of looks(true)) {
        for (const view of ["side", "top"] as const) {
          for (const act of ACTIONS) {
            for (const night of light.night ? [true] : [false, true]) {
              for (const t of [0.25, 0.45, 0.8, 1.2, 1.7]) {
                const prims = nd(light, () => propPrims(castCar(), view, act, t, { car, night, face: "surprised" }));
                // inside the frame and its margin (a beam reaches past it at night, as the classic car's does)
                expect(problems(prims, night ? null : FRAME), `${car.body} ${view} ${act} at ${t}`).toEqual([]);
                busiest = Math.max(busiest, prims.length);
              }
            }
          }
        }
      }
    }
    expect(busiest).toBeLessThanOrEqual(CAR_CAST_SHAPES_ND);
    // the constant is the measured busiest frame, not a guess far above it
    expect(busiest).toBeGreaterThanOrEqual(CAR_CAST_SHAPES_ND - 6);
  });

  it("its own colours stand in the light: a red car is a night red at night and its own red in the studio", () => {
    const car: CarLook = { ...DEFAULT_CAR, paint: "#d8352a" };
    // about #932925 (§45.45 §4.1)
    expect(grade("#d8352a", LIGHTS.night)).toMatch(/^#9[23]2[89]2[4-7]$/);
    for (const view of ["side", "top"] as const) {
      const night = colours(nd(LIGHTS.night, () => propPrims(castCar(), view, null, 0.5, { car, night: true })));
      expect(night.has(grade("#d8352a", LIGHTS.night)), view).toBe(true);
      expect(night.has("#d8352a"), view).toBe(false);
      const studio = colours(nd(LIGHTS.studio, () => propPrims(castCar(), view, null, 0.5, { car })));
      expect(studio.has("#d8352a"), view).toBe(true);
      // the soft ink, never the heavy navy
      expect(studio.has(ink("#1c1842")), view).toBe(true);
      expect(studio.has("#1c1842"), view).toBe(false);
    }
  });

  it("draws soft thin lines of about 2.6 px however close the camera is (classic lines grow with it)", () => {
    const outlineGap = (art: "night_drive" | "classic", zoom: number): number => {
      const pen = new Pen();
      pen.translate(540, 1300);
      pen.scale(zoom);
      pen.translate(-540, -1300);
      const prims = art === "classic" ? propPrims(castCar(), "side", null, 0.5, { car: DEFAULT_CAR, pen }) : nd(LIGHTS.studio, () => propPrims(castCar(), "side", null, 0.5, { car: DEFAULT_CAR, pen }));
      const polys = prims.filter((p): p is Extract<Prim, { k: "poly" }> => p.k === "poly");
      const outline = polys.find((p) => p.color === (art === "classic" ? "#1c1842" : ink("#1c1842")))!;
      const body = polys.find((p) => p.color === "#d8352a")!;
      return extent(outline)![2] - extent(body)![2];
    };
    for (const zoom of [0.6, 1, 2.2]) {
      expect(outlineGap("night_drive", zoom), `zoom ${zoom}`).toBeGreaterThan(2);
      expect(outlineGap("night_drive", zoom), `zoom ${zoom}`).toBeLessThan(3.6);
    }
    expect(outlineGap("classic", 2.2)).toBeGreaterThan(10);
  });

  it("keeps each plate one plain light rectangle, standing in the light", () => {
    const car: CarLook = { ...DEFAULT_CAR, accent: "#47d6a0" };
    for (const view of ["side", "top"] as const) {
      const studio = nd(LIGHTS.studio, () => propPrims(castCar(), view, null, 0.5, { car }));
      expect(studio.filter((p) => "color" in p && p.color === "#f4f1ea").map((p) => p.k), view).toEqual(["rect", "rect"]);
      const night = nd(LIGHTS.night, () => propPrims(castCar(), view, null, 0.5, { car, night: true }));
      expect(night.filter((p) => "color" in p && p.color === grade("#f4f1ea", LIGHTS.night)).map((p) => p.k), view).toEqual(["rect", "rect"]);
    }
  });

  it("lights glow at night (white headlights with bloom, red tail lights), brighter red on the brakes, and are off by day", () => {
    for (const view of ["side", "top"] as const) {
      const night = colours(nd(NIGHT, () => propPrims(castCar(), view, null, 0.5, { car: DEFAULT_CAR, night: true })));
      for (const c of [ND.headCore, ND.headBloom, ND.tailCore, ND.tailGlow, ND.beam]) expect(night.has(c), `${view} ${c}`).toBe(true);
      const braking = colours(nd(NIGHT, () => propPrims(castCar({ state: "brakes" }), view, null, 0.5, { car: DEFAULT_CAR, night: true })));
      expect(braking.has(ND.brakeCore), view).toBe(true);
      expect(braking.has(ND.tailCore), view).toBe(false);
      const day = colours(nd(LIGHTS.day, () => propPrims(castCar(), view, null, 0.5, { car: DEFAULT_CAR })));
      for (const c of [ND.headCore, ND.headBloom, ND.tailGlow, ND.beam]) expect(day.has(c), `${view} by day ${c}`).toBe(false);
    }
  });

  it("has door lines, handles, a mirror on a stalk, an amber side marker, glass reflections and rim light in the side view", () => {
    const prims = nd(NIGHT, () => propPrims(castCar(), "side", null, 0.5, { car: DEFAULT_CAR, night: true }));
    const by = (c: string) => prims.filter((p) => "color" in p && p.color === c);
    expect(by(ND.marker)).toHaveLength(1);
    expect(by("#ffffff").filter((p) => p.k === "poly" && alphaOf(p) <= 0.12)).toHaveLength(2);
    expect(by(NIGHT.rim).filter((p) => p.k === "line")).toHaveLength(1);
    // two door lines in the soft ink, thinner than the outline
    expect(by(ink("#1c1842")).filter((p) => p.k === "line")).toHaveLength(2);
    expect(by(ND.ao).length).toBeGreaterThanOrEqual(2);
  });

  it("every move still shows: honk waves, exhaust and speed lines, in the light's colours", () => {
    const honk = nd(LIGHTS.night, () => propPrims(castCar(), "side", "honk", 0.5, { car: DEFAULT_CAR, night: true }));
    expect(honk.filter((p) => p.k === "line" && p.color === grade("#ffc94a", LIGHTS.night))).toHaveLength(3);
    const puff = nd(LIGHTS.night, () => propPrims(castCar(), "side", "speed_up", 0.4, { car: DEFAULT_CAR, night: true }));
    expect(puff.some((p) => p.k === "circle" && p.color === grade("#d9dde3", LIGHTS.night))).toBe(true);
  });

  it("draws the same every time", () => {
    for (const car of looks(true).slice(0, 4)) {
      const a = nd(NIGHT, () => propPrims(castCar(), "side", "bounce", 0.9, { car, night: true, face: "angry" }));
      const b = nd(NIGHT, () => propPrims(castCar(), "side", "bounce", 0.9, { car: JSON.parse(JSON.stringify(car)) as CarLook, night: true, face: "angry" }));
      expect(b).toEqual(a);
    }
  });
});

describe("a plain car, a truck and the other props in night drive", () => {
  it(`a plain car, a truck and a deer stay within PROP_SHAPES_ND (${JSON.stringify(PROP_SHAPES_ND)}), measured`, () => {
    for (const kind of ["car", "truck", "deer"] as const) {
      let busiest = 0;
      for (const light of [NIGHT, LIGHTS.day]) {
        for (const view of ["side", "top"] as const) {
          for (const act of ACTIONS) {
            for (const t of [0.25, 0.45, 0.8, 1.2, 1.7]) {
              const prop: SceneProp = { propId: "p", kind, x: 0.5, y: 0.72, scale: 0.8, rot: 0 };
              const prims = nd(light, () => propPrims(prop, view, act, t, { night: light.night }));
              expect(problems(prims, light.night ? null : FRAME), `${kind} ${view} ${act} at ${t}`).toEqual([]);
              busiest = Math.max(busiest, prims.length);
            }
          }
        }
      }
      expect(busiest, kind).toBeLessThanOrEqual(PROP_SHAPES_ND[kind]);
      expect(busiest, kind).toBeGreaterThanOrEqual(PROP_SHAPES_ND[kind] - 6);
    }
  });

  it("a plain car with no colour gets a muted one by its id in night drive, and keeps its own colour when it has one", () => {
    const prop: SceneProp = { propId: "lorry", kind: "truck", x: 0.5, y: 0.7, scale: 1, rot: 0 };
    expect(plainColor(prop, false)).toBe("#47d6a0");
    expect(plainColor(prop, true)).toBe(plainColor({ ...prop }, true));
    expect(plainColor(prop, true)).not.toBe("#47d6a0");
    expect(plainColor({ ...prop, color: "#3388FF" }, true)).toBe("#3388ff");
    const prims = nd(LIGHTS.night, () => propPrims({ ...prop, kind: "car", color: "#3388ff" }, "side", null, 0.5, { night: true }));
    expect(colours(prims).has(grade("#3388ff", LIGHTS.night))).toBe(true);
    // a truck's box is its own light colour, the same from the side and from behind
    const truck = nd(LIGHTS.night, () => propPrims(prop, "side", null, 0.5, { night: true }));
    expect(colours(truck).has(grade(BOX_ND, LIGHTS.night))).toBe(true);
  });

  it("every other prop's own colours stand in the light, with thin soft outlines", () => {
    for (const kind of OTHER_KINDS) {
      const prop: SceneProp = { propId: "q", kind, x: 0.5, y: 0.7, scale: 1, rot: 0 };
      const classic = propPrims(prop, "side", null, 0.5);
      const night = nd(LIGHTS.night, () => propPrims(prop, "side", null, 0.5, { night: true }));
      // the same shapes (a tyre gets the night drive wheel's sidewall and rim shadow)
      if (kind !== "tyre") expect(night.length, kind).toBe(classic.length);
      const raw = [...colours(classic)].filter((c) => c !== "#1c1842" && c !== "#000000");
      for (const c of raw) expect(colours(night).has(c), `${kind} ${c}`).toBe(false);
    }
    // the cone's outline is about 2.2 px against classic's 5 units
    const prop: SceneProp = { propId: "q", kind: "cone", x: 0.5, y: 0.7, scale: 1, rot: 0 };
    const gap = (prims: Prim[], outline: string) => {
      const polys = prims.filter((p) => p.k === "poly");
      return extent(polys.find((p) => p.color === outline)!)![2] - extent(polys.find((p) => p.color !== outline && p.k === "poly" && extent(p)![3] - extent(p)![1] > 100)!)![2];
    };
    expect(gap(nd(LIGHTS.night, () => propPrims(prop, "side", null, 0.5)), ink("#1c1842"))).toBeLessThan(3.2);
    expect(gap(propPrims(prop, "side", null, 0.5), "#1c1842")).toBeGreaterThan(4);
  });
});

describe("a car from the back and from the front (the shots)", () => {
  const base = (extra: Partial<CarViewOpts> = {}): CarViewOpts => ({ x: 540, y: 1200, w: 300, side: 0, light: NIGHT, braking: 0, lights: false, blink: 0, face: null, t: 0.5, seed: 3, ...extra });
  const view = (car: CarLook, v: "back" | "front", o: CarViewOpts): Prim[] => {
    const pen = new Pen();
    nd(o.light, () => drawCarView(pen, car, v, o));
    return pen.out;
  };
  const faces = ids(CATALOG.expressions);

  it(`every look, side, light and move draws in the allowed shapes, inside its box, within CAR_VIEW_SHAPES (${CAR_VIEW_SHAPES}) prims`, () => {
    let busiest = 0;
    const all: { car: CarLook; truck?: boolean }[] = [...looks(true), ...looks(false)].map((car) => ({ car }));
    all.push({ car: plainCarLook("#c9a227") }, { car: plainCarLook("#5b5f2e"), truck: true });
    for (const { car, truck } of all) {
      for (const v of ["back", "front"] as const) {
        for (const side of [-1, -0.4, 0, 0.3, 1]) {
          for (const light of [NIGHT, LIGHTS.day, LIGHTS.cabin]) {
            for (const [braking, lights, blink] of [
              [0, false, 0],
              [1, true, 0],
              [0.6, false, 1],
            ] as [number, boolean, number][]) {
              for (const face of ["happy", "angry", "surprised", "sad"] as Expression[]) {
                for (const w of [24, 300]) {
                  const o = base({ side, light, braking, lights, blink, face, w, truck, bloom: blink ? 1.8 : 1 });
                  const prims = view(car, v, o);
                  // the car and its glow stay near it: a width either side, a car and a half above the ground (and the
                  // soft line, a few px whatever the size)
                  const box = { x0: o.x - 1.05 * w - 8, y0: o.y - 1.6 * w - 8, x1: o.x + 1.05 * w + 8, y1: o.y + 0.3 * w + 8 };
                  expect(problems(prims, box), `${car.body} ${v} side ${side} ${braking} ${lights} ${blink} ${face} ${w}`).toEqual([]);
                  busiest = Math.max(busiest, prims.length);
                }
              }
            }
          }
        }
      }
    }
    expect(busiest).toBeLessThanOrEqual(CAR_VIEW_SHAPES);
    expect(busiest).toBeGreaterThanOrEqual(CAR_VIEW_SHAPES - 4);
  });

  it("is the same car in every shot: its own paint in the light, the soft ink, plain light plates", () => {
    const car: CarLook = { ...DEFAULT_CAR, paint: "#d8352a" };
    for (const v of ["back", "front"] as const) {
      const night = colours(view(car, v, base({ light: LIGHTS.night })));
      expect(night.has(grade("#d8352a", LIGHTS.night)), v).toBe(true);
      expect(night.has(ink("#1c1842")), v).toBe(true);
      expect(colours(view(car, v, base({ light: LIGHTS.studio }))).has("#d8352a"), v).toBe(true);
    }
    expect(view(car, "back", base()).filter((p) => "color" in p && p.color === grade("#f4f1ea", NIGHT)).map((p) => p.k)).toEqual(["rect"]);
  });

  it("shows the tail lights by their style, red at night and brighter on the brakes", () => {
    const tails = (rear: CarLook["lights"]["rear"], braking: number) => {
      const prims = view({ ...DEFAULT_CAR, lights: { front: "round", rear } }, "back", base({ braking }));
      return prims.filter((p) => "color" in p && (p.color === ND.tailCore || p.color === ND.brakeCore));
    };
    expect(tails("round", 0).map((p) => p.k)).toEqual(["circle", "circle"]);
    expect(tails("bar", 0).map((p) => p.k)).toEqual(["rect"]);
    expect(tails("square", 0).map((p) => p.k)).toEqual(["rect", "rect"]);
    expect(tails("round", 1).every((p) => "color" in p && p.color === ND.brakeCore)).toBe(true);
    const glowA = (braking: number) => Math.max(...view(DEFAULT_CAR, "back", base({ braking })).filter((p) => "color" in p && p.color === ND.tailGlow).map(alphaOf));
    expect(glowA(1)).toBeGreaterThan(glowA(0));
    // by day with no brakes, the tail lights are off and nothing glows
    expect(view(DEFAULT_CAR, "back", base({ light: LIGHTS.day })).some((p) => "color" in p && (p.color === ND.tailGlow || p.color === ND.tailCore))).toBe(false);
  });

  it("headlights bloom at night, flare more in the mirror, and are off by day", () => {
    const bloomA = (o: CarViewOpts) => view(DEFAULT_CAR, "front", o).filter((p) => "color" in p && p.color === ND.headBloom).reduce((s, p) => s + alphaOf(p), 0);
    expect(bloomA(base())).toBeGreaterThan(0);
    expect(bloomA(base({ bloom: 1.8 }))).toBeGreaterThan(bloomA(base()));
    expect(bloomA(base({ light: LIGHTS.day }))).toBe(0);
    expect(bloomA(base({ light: LIGHTS.day, blink: 1 }))).toBeGreaterThan(0);
  });

  it("shows a face only from the front: the windscreen eyes change with the face, the back is the same for every face", () => {
    for (const eyes of ["windscreen", "headlights"] as const) {
      const car: CarLook = { ...DEFAULT_CAR, face: { eyes, color: "#1c1842", mouth: "grille" } };
      const back = view(car, "back", base({ face: "neutral" }));
      for (const face of faces) expect(view(car, "back", base({ face })), `${eyes} ${face} back`).toEqual(back);
      const t = 0.05;
      const neutral = view(car, "front", base({ face: "neutral", t }));
      expect(neutral.length, eyes).toBeGreaterThan(view(DEFAULT_CAR, "front", base({ face: "neutral", t })).length);
      for (const face of faces.filter((f) => f !== "neutral")) expect(view(car, "front", base({ face, t })), `${eyes} ${face}`).not.toEqual(neutral);
    }
    // a car with no eyes looks the same whatever its face
    expect(view(DEFAULT_CAR, "front", base({ face: "angry" }))).toEqual(view(DEFAULT_CAR, "front", base({ face: "happy" })));
  });

  it("shows one side towards the vanishing point: a side on the right reaches further right, one on the left further left", () => {
    const span = (side: number): [number, number] => {
      // the car itself, not its soft shadow on the road
      const prims = view(DEFAULT_CAR, "back", base({ side, light: LIGHTS.day })).filter((p) => !("color" in p) || p.color !== ND.ao);
      const boxes = prims.map(extent).filter((e): e is [number, number, number, number] => e !== null);
      return [Math.min(...boxes.map((b) => b[0])), Math.max(...boxes.map((b) => b[2]))];
    };
    const [l0, r0] = span(0);
    const [l1, r1] = span(0.8);
    const [l2, r2] = span(-0.8);
    expect(r1).toBeGreaterThan(r0 + 20);
    expect(l1).toBeCloseTo(l0, 0);
    expect(l2).toBeLessThan(l0 - 20);
    expect(r2).toBeCloseTo(r0, 0);
  });

  it("draws a plain car as a sedan in its colour and a truck with its box, from the prop's state", () => {
    expect(plainCarLook("#c9a227")).toMatchObject({ body: "sedan", paint: "#c9a227", wheels: { style: "steel" }, face: { eyes: "none" } });
    const errors: string[] = [];
    checkCarLook(plainCarLook("#c9a227"), "plain", (m) => errors.push(m));
    expect(errors).toEqual([]);
    const draw = (prop: SceneProp, car?: CarDraw) => {
      const st = propState(prop, [], "side", 0.5, { braking: 1, steer: 0, rolled: 0 });
      const pen = new Pen();
      nd(LIGHTS.night, () => drawPropView(pen, st, "back", { x: 540, y: 1200, w: 300, side: 0.2, light: LIGHTS.night, t: 0.5, seed: 3 }, car));
      return pen.out;
    };
    const plain = draw({ propId: "p", kind: "car", x: 0.5, y: 0.7, scale: 1, rot: 0, color: "#3388ff" });
    expect(colours(plain).has(grade("#3388ff", LIGHTS.night))).toBe(true);
    expect(colours(plain).has(ND.brakeCore)).toBe(true);
    const truck = draw({ propId: "t", kind: "truck", x: 0.5, y: 0.7, scale: 1, rot: 0 });
    expect(colours(truck).has(grade(BOX_ND, LIGHTS.night))).toBe(true);
    const cast = draw(castCar(), { car: { ...DEFAULT_CAR, paint: "#2f6fd1" }, style: "calm", seed: 3 });
    expect(colours(cast).has(grade("#2f6fd1", LIGHTS.night))).toBe(true);
  });

  it("draws the same every time and puts the pen back", () => {
    const pen = new Pen();
    const before = [...pen.m];
    const o = base({ side: 0.5, face: "happy", lights: true });
    const car: CarLook = { ...DEFAULT_CAR, face: { eyes: "windscreen", color: "#1c1842", mouth: "grille" } };
    nd(NIGHT, () => drawCarView(pen, car, "front", o));
    expect(pen.m).toEqual(before);
    expect(view(car, "front", o)).toEqual(pen.out);
  });
});
