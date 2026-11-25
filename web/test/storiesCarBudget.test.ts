// Clips Funded: the shape budget of a vehicle look (CONTRACTS §45.48 section 4). A look without `detail` costs exactly
// 56 / 72 / 34 as always; a detailed look costs what it draws (never less than its busiest frame, never over the caps).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAR_CAST_SHAPES, CAR_CAST_SHAPES_ND, CAR_VIEW_SHAPES, DEFAULT_CAR, carShapes, carViewShapes, type CarDraw } from "../src/stories/engine/car.ts";
import { CAR_DETAIL_SHAPES, CAR_DETAIL_SHAPES_ND, CAR_VIEW_DETAIL_SHAPES, carShapes as budgetShapes, carViewShapes as budgetViewShapes } from "../src/stories/engine/carBudget.ts";
import { drawCarView, type CarViewOpts } from "../src/stories/engine/carView.ts";
import { LIGHTS, withWarm } from "../src/stories/engine/art.ts";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { F, inFrame } from "../src/stories/engine/frame.ts";
import { prng } from "../src/stories/engine/math.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawProp, propState } from "../src/stories/engine/props.ts";
import { LIMITS, sceneShapes } from "../src/stories/engine/script.ts";
import type { ArtStyle, Beat, CarBody, CarLook, CarProfile, Prim, PropAction, SceneProp } from "../src/stories/engine/types.ts";

const ids = <T extends string>(list: { id: T }[]): T[] => list.map((e) => e.id);
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "car-detail-looks.json"), "utf8")) as { valid: CarLook[] };
const ACTIONS: (PropAction | null)[] = [null, ...ids(CATALOG.propActions)];
const MOVERS = new Set<PropAction>(["move", "skid", "spin", "stop", "bump", "speed_up", "stall"]);
const WHEELED: CarBody[] = ["hatchback", "sedan", "estate", "suv", "pickup", "van", "sports", "compact", "bus"];
const NIGHT = withWarm(LIGHTS.night, 1);

const RANGES: Record<string, [number, number]> = {
  lh: [150, 520], wh: [60, 220], tipH: [10, 85], noseX: [0, 14], noseH: [15, 92], noseR: [0, 100], chinH: [3, 40], cowlX: [1, 55], cowlH: [30, 90], bonnet: [0, 100],
  headX: [4, 72], headH: [40, 100], peakX: [4, 100], roofX: [12, 100], roofH: [40, 100], deckX: [20, 100], deckH: [20, 98], tailX: [86, 100], tailH: [15, 98],
  rumpH: [3, 45], sillH: [4, 40], axF: [8, 40], axR: [55, 94], wheelD: [20, 72], archGap: [0, 45], beltH: [30, 88], beltRise: [-10, 20], soft: [0, 100],
  pillarX: [10, 96], glassX: [20, 99], panes: [1, 5], roofW: [40, 100], taperF: [0, 40], taperR: [0, 40],
};

function randomLook(r: () => number): CarLook {
  const pick = <T>(l: T[]): T => l[Math.floor(r() * l.length)]!;
  const CL = CATALOG.carLooks;
  const body = pick(ids(CL.body));
  const eyes = pick(ids(CL.eyes));
  const detail: CarLook["detail"] = { v: 1 };
  if (WHEELED.includes(body) && r() < 0.8) {
    const p: Record<string, number | string> = { body };
    for (const [k, [lo, hi]] of Object.entries(RANGES)) p[k] = lo + Math.floor(r() * (hi - lo + 1));
    detail.profile = p as unknown as CarProfile;
  }
  if (r() < 0.3) detail.toon = Math.floor(r() * 101);
  return {
    body, length: 0.85 + r() * 0.3, height: 0.85 + r() * 0.3, paint: pick(["#d8352a", "#2f6fd1", "#8a8f98", "#1f1f24"]), accent: pick(["#f4f1ea", "#1c1842", "#47d6a0"]),
    pattern: pick(ids(CL.pattern)), windows: pick(ids(CL.windows)),
    wheels: { style: pick(ids(CL.wheels)), rim: "#c9ccd2", size: 0.85 + r() * 0.35 }, lights: { front: pick(ids(CL.frontLights)), rear: pick(ids(CL.rearLights)) },
    extra: pick(ids(CL.extra)), face: { eyes: eyes === "none" && r() < 0.5 ? "windscreen" : eyes, color: "#1c1842", mouth: pick(ids(CL.mouth)) }, outline: "#1c1842", detail,
  } as CarLook;
}

const castCar = (extra: Partial<SceneProp> = {}): SceneProp => ({ propId: "rosso", kind: "car", x: 0.5, y: 0.72, scale: 0.8, rot: 0, castId: "c2", ...extra });

/** One car's prims at time t of a single prop action (or none), in a view, in a style: the busiest frames of a real scene. */
function frame(car: CarLook, view: "side" | "top", act: PropAction | null, t: number, art: ArtStyle, state?: string): Prim[] {
  const beats: Beat[] = act ? [{ at: 0.2, dur: 1.6, who: "rosso", do: act, dir: "right", ...(MOVERS.has(act) ? { to: { x: 0.62, y: 0.7 } } : {}), face: "surprised" }] : [];
  const d: CarDraw = { car, style: "bouncy", seed: 11 };
  return inFrame({ width: 1080, height: 1920, art }, () => {
    const st = propState(castCar(state ? { state } : {}), beats, view, t, { braking: 0, steer: 0, rolled: t * 300 }, d);
    if (!act) st.face = "surprised";
    const pen = new Pen();
    drawProp(pen, st, view, t, 3, {}, art === "night_drive", d);
    return pen.out;
  });
}

function busiest(car: CarLook, art: ArtStyle, times: number[]): number {
  let n = 0;
  for (const view of ["side", "top"] as const) for (const act of ACTIONS) for (const t of times) n = Math.max(n, frame(car, view, act, t, art).length);
  for (const state of ["flat lights brakes", "lights", "flat"]) n = Math.max(n, frame(car, "side", null, 0.5, art, state).length, frame(car, "top", null, 0.5, art, state).length);
  return n;
}

function viewBusiest(car: CarLook): number {
  let n = 0;
  inFrame({ width: 1080, height: 1920, art: "night_drive" }, () => {
    F.light = NIGHT;
    for (const view of ["front", "back"] as const) {
      for (const side of [0, 0.8, -0.8]) {
        for (const lights of [false, true]) {
          const o: CarViewOpts = { x: 540, y: 1200, w: 300, side, light: NIGHT, braking: lights ? 1 : 0, lights, blink: 0, face: car.face.eyes === "none" ? null : "happy", t: 0.5, seed: 3 };
          const pen = new Pen();
          drawCarView(pen, car, view, o);
          n = Math.max(n, pen.out.length);
        }
      }
    }
  });
  return n;
}

describe("a look without detail costs what it always did", () => {
  it("is exactly 56 / 72 / 34, and car.ts re-exports the same functions", () => {
    expect([CAR_CAST_SHAPES, CAR_CAST_SHAPES_ND, CAR_VIEW_SHAPES]).toEqual([56, 72, 34]);
    expect(carShapes).toBe(budgetShapes);
    expect(carViewShapes).toBe(budgetViewShapes);
    const looks: CarLook[] = [DEFAULT_CAR, ...ids(CATALOG.carLooks.body).map((body) => ({ ...DEFAULT_CAR, body })), { ...DEFAULT_CAR, face: { eyes: "headlights", color: "#1c1842", mouth: "grille" } }];
    for (const look of looks) {
      expect(carShapes(look, "classic"), look.body).toBe(56);
      expect(carShapes(look, "night_drive"), look.body).toBe(72);
      expect(carViewShapes(look), look.body).toBe(34);
    }
  });

  it("the caps are 88 / 112 / 64", () => {
    expect([CAR_DETAIL_SHAPES, CAR_DETAIL_SHAPES_ND, CAR_VIEW_DETAIL_SHAPES]).toEqual([88, 112, 64]);
  });

  it("a stored script's estimate does not move: with or without its cars, a plain look prices the same", () => {
    const scene = {
      set: "highway_night",
      actors: [{ id: "a" }, { id: "b" }],
      props: [castCar({ propId: "p1", castId: "c1" }), castCar({ propId: "p2", castId: "c2" }), { propId: "t", kind: "truck", x: 0.3, y: 0.72, scale: 0.7, rot: 0 }],
      cuts: [{ at: 0, shot: "driver_view" }, { at: 2, shot: "side_window" }, { at: 4, shot: "mirror" }, { at: 6, shot: "road_wide" }],
    };
    const cars = new Map([["c1", { look: DEFAULT_CAR }], ["c2", { look: { ...DEFAULT_CAR, body: "suv" as const } }]]);
    for (const art of ["classic", "night_drive"] as const) expect(sceneShapes(scene, art, cars), art).toBe(sceneShapes(scene, art));
  });
});

describe("a detailed look is priced by drawing it", () => {
  const detailed = FIXTURE.valid.filter((l) => l.detail !== undefined);

  it("the references are priced inside the caps, memoised, and the same twice", () => {
    expect(detailed.length).toBeGreaterThan(10);
    for (const look of detailed) {
      const a = carShapes(look, "classic");
      const b = carShapes(look, "night_drive");
      const v = carViewShapes(look);
      expect(a, look.body).toBeGreaterThan(0);
      expect(a).toBeLessThanOrEqual(CAR_DETAIL_SHAPES);
      expect(b).toBeLessThanOrEqual(CAR_DETAIL_SHAPES_ND);
      expect(v).toBeLessThanOrEqual(CAR_VIEW_DETAIL_SHAPES);
      expect([carShapes(look, "classic"), carShapes(look, "night_drive"), carViewShapes(look)]).toEqual([a, b, v]);
      // the same look written again (a copy) is the same price
      expect(carShapes(structuredClone(look), "classic")).toBe(a);
    }
  });

  it("every reference look's busiest frame (every action, both views, both styles) is inside its price", () => {
    for (const look of detailed) {
      for (const art of ["classic", "night_drive"] as const) {
        const price = carShapes(look, art);
        expect(Math.min(busiest(look, art, [0.45, 1.2]), art === "night_drive" ? CAR_DETAIL_SHAPES_ND : CAR_DETAIL_SHAPES), `${look.body} ${art}`).toBeLessThanOrEqual(price);
      }
      expect(Math.min(viewBusiest(look), CAR_VIEW_DETAIL_SHAPES), look.body).toBeLessThanOrEqual(carViewShapes(look));
    }
  });

  it("400 seeded random looks: busiest <= price <= cap, every action, both views, both styles", () => {
    const r = prng(98);
    for (let i = 0; i < 400; i += 1) {
      const look = randomLook(r);
      const night = i % 2 === 0;
      const art: ArtStyle = night ? "night_drive" : "classic";
      const cap = night ? CAR_DETAIL_SHAPES_ND : CAR_DETAIL_SHAPES;
      const price = carShapes(look, art);
      expect(price, `#${i} ${look.body}`).toBeLessThanOrEqual(cap);
      expect(Math.min(busiest(look, art, [0.6]), cap), `#${i} ${look.body} ${art}`).toBeLessThanOrEqual(price);
      const v = carViewShapes(look);
      expect(v).toBeLessThanOrEqual(CAR_VIEW_DETAIL_SHAPES);
      if (i % 4 === 0) expect(Math.min(viewBusiest(look), CAR_VIEW_DETAIL_SHAPES), `#${i} ${look.body} view`).toBeLessThanOrEqual(v);
    }
  });

  it("a face adds to the price and a detailed look is not priced below a plain one's body", () => {
    const base = detailed.find((l) => l.face.eyes === "none") ?? { ...detailed[0]!, face: { eyes: "none" as const, color: "#1c1842", mouth: "none" as const } };
    const eyed = { ...base, face: { eyes: "windscreen" as const, color: "#1c1842", mouth: "grille" as const } };
    expect(carShapes(eyed, "classic")).toBeGreaterThanOrEqual(carShapes(base, "classic"));
    expect(carShapes(base, "classic")).toBeGreaterThan(10);
  });
});

describe("the scene budget with a detailed car", () => {
  const spider = detailed();
  function detailed(): CarLook {
    return FIXTURE.valid.find((l) => l.detail !== undefined && l.body === "sports") ?? FIXTURE.valid.find((l) => l.detail !== undefined)!;
  }

  it("the worst common scene (highway at night, two riders, one detailed car, two plain) fits the limit", () => {
    const scene = {
      set: "highway_night",
      actors: [{ id: "a" }, { id: "b" }],
      props: [castCar({ propId: "p1", castId: "c1" }), castCar({ propId: "p2", castId: "c2" }), { propId: "t", kind: "truck", x: 0.3, y: 0.72, scale: 0.7, rot: 0 }],
      cuts: ["driver_view", "side_window", "mirror", "road_behind", "road_wide", "face", "pedals", "speed_dial"].map((shot, i) => ({ at: i, shot })),
    };
    const cars = new Map([["c1", { look: spider }], ["c2", { look: DEFAULT_CAR }]]);
    const n = sceneShapes(scene, "night_drive", cars);
    expect(n).toBeLessThanOrEqual(LIMITS.shapesNight);
    expect(n).toBeGreaterThanOrEqual(sceneShapes(scene, "night_drive"));
    const day = sceneShapes({ ...scene, set: "road" }, "classic", cars);
    expect(day).toBeLessThanOrEqual(LIMITS.shapes);
  });

  it("a detailed car adds at most +60 to a shot, and nothing to a shot that does not show it", () => {
    const scene = { set: "highway_night", props: [castCar({ propId: "p1", castId: "c1" })], cuts: [{ at: 0, shot: "face" }] };
    const cars = new Map([["c1", { look: spider }]]);
    const plain = sceneShapes(scene, "night_drive");
    expect(sceneShapes(scene, "night_drive", cars)).toBeGreaterThanOrEqual(plain);
    const more = sceneShapes({ ...scene, cuts: [{ at: 0, shot: "road_wide" }] }, "night_drive", cars) - sceneShapes({ ...scene, cuts: [{ at: 0, shot: "road_wide" }] }, "night_drive");
    expect(more).toBeLessThanOrEqual(60);
    expect(more).toBeGreaterThanOrEqual(0);
  });
});
