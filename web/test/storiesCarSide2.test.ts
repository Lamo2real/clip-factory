// The detailed vehicle's side drawer (carSide2.ts, CONTRACTS §45.48): every action, both styles, the faces, the riders,
// the plates, the brake lights and the budget. A look without `detail` is guarded by storiesCarLegacy.test.ts.
import { describe, expect, it } from "vitest";
import { LIGHTS, ND, withWarm, type Light } from "../src/stories/engine/art.ts";
import type { CarDraw } from "../src/stories/engine/car.ts";
import { CAR_DETAIL_SHAPES, CAR_DETAIL_SHAPES_ND } from "../src/stories/engine/carBudget.ts";
import { sideShape } from "../src/stories/engine/carShape.ts";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { F, inFrame } from "../src/stories/engine/frame.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawProp, propState } from "../src/stories/engine/props.ts";
import type { Beat, CarLook, CarProfile, Expression, Prim, PropAction, SceneProp } from "../src/stories/engine/types.ts";

const NIGHT = withWarm(LIGHTS.night, 1);
const FRAME = { x0: -60, y0: -60, x1: 1140, y1: 1980 };
const ACTIONS: (PropAction | null)[] = [null, ...CATALOG.propActions.map((a) => a.id)];
const MOVERS = new Set<PropAction>(["move", "skid", "spin", "stop", "bump", "speed_up", "stall"]);

const PROFILE: CarProfile = { body: "sports", lh: 379, wh: 162, tipH: 30, noseX: 3, noseH: 42, noseR: 20, chinH: 9, cowlX: 33, cowlH: 71, bonnet: 55, headX: 46, headH: 100, peakX: 50, roofX: 62, roofH: 97, deckX: 80, deckH: 84, tailX: 97, tailH: 81, rumpH: 15, sillH: 10, axF: 23, axR: 81, wheelD: 57, archGap: 9, beltH: 72, beltRise: 2, soft: 55, pillarX: 60, glassX: 62, panes: 1, roofW: 62, taperF: 22, taperR: 8 };
const SPIDER: CarLook = {
  body: "sports", length: 1, height: 1, paint: "#55575a", accent: "#111111", pattern: "racing_stripes", windows: "clear",
  wheels: { style: "sport", rim: "#1a1a1a", size: 1 }, lights: { front: "slim", rear: "round" }, extra: "none",
  face: { eyes: "none", color: "#1c1842", mouth: "none" }, outline: "#141414",
  detail: {
    v: 1, toon: 30, profile: PROFILE, roof: { type: "open", hoops: "twin" }, wheels: { shape: "split", spokes: 5, tyre: 22, lip: 10 }, brakes: { disc: "ceramic", caliper: "#ffd21f" },
    lights: { front: { shape: "swept", drl: "line" }, rear: { shape: "round" } }, front: { grille: "none", intake: "split3", splitter: "blade", bumper: "body" }, bonnet: { vent: "duct" },
    side: { intake: "scoop", intakeX: 66, skirts: "lip", doors: 1, handles: "flush", crease: "wedge", mirror: "stalk" }, rear: { diffuser: "fins", exhaust: "high", spoiler: "ducktail" },
    stripe: { layout: "centre", color: "#111111", width: 60 }, finish: "satin", cabin: { rows: 1, seat: "#1b1b1d", dial: "#ffd21f", wheel: "flat" },
  },
};
/** A closed car with the busy parts on: the other branch of the drawer. */
const WAGON: CarLook = {
  body: "suv", length: 1, height: 1, paint: "#c9c2ae", accent: "#47d6a0", pattern: "plain", windows: "tinted",
  wheels: { style: "offroad", rim: "#2a2c30", size: 1 }, lights: { front: "round", rear: "square" }, extra: "none",
  face: { eyes: "none", color: "#1c1842", mouth: "none" }, outline: "#17181b",
  detail: {
    v: 1, roof: { type: "closed", rails: true }, brakes: { disc: "plain", caliper: "#c8102e" }, lights: { front: { shape: "round", drl: "ring" }, rear: { shape: "tall" } },
    front: { grille: "bars", bumper: "black", fog: true }, side: { skirts: "boards", doors: 2, handles: "chrome", mirror: "square", rubStrip: true, fuelCap: true }, rear: { exhaust: "side", bumper: "black" },
    arches: "square", extras: ["spare_wheel", "bull_bar", "wing_lamps", "antenna"], cabin: { rows: 2 },
  },
};
const withFace = (car: CarLook, eyes: CarLook["face"]["eyes"], mouth: CarLook["face"]["mouth"] = "grille"): CarLook => ({ ...car, face: { ...car.face, eyes, mouth } });
const LOOKS: Record<string, CarLook> = { spider: SPIDER, wagon: WAGON, spiderWindscreenEyes: withFace(SPIDER, "windscreen"), wagonHeadEyes: withFace(WAGON, "headlights") };

const numbers = (p: Prim): number[] => Object.values(p).flatMap((v) => (typeof v === "number" ? [v] : Array.isArray(v) ? v.flat().filter((x): x is number => typeof x === "number") : []));
function extent(p: Prim): [number, number, number, number] | null {
  if (p.k === "circle") return [p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r];
  if (p.k === "ellipse" || p.k === "glow") {
    const r = Math.max(p.rx, p.ry);
    return [p.x - r, p.y - r, p.x + r, p.y + r];
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
const colours = (prims: Prim[]): Set<string> => new Set(prims.flatMap((p) => ("color" in p ? [p.color] : [])));

function run<T>(night: boolean, light: Readonly<Light>, fn: () => T): T {
  return inFrame({ width: 1080, height: 1920, art: night ? "night_drive" : "classic" }, () => {
    F.light = light;
    return fn();
  });
}
const prop = (): SceneProp => ({ propId: "rosso", kind: "car", x: 0.5, y: 0.72, scale: 0.8, rot: 0, castId: "c2" });

interface Opts { night?: boolean; face?: Expression; braking?: number; lights?: boolean; occ?: Parameters<typeof drawProp>[5]; zoom?: number }
function draw(car: CarLook, act: PropAction | null, t: number, o: Opts = {}): Prim[] {
  const night = o.night ?? false;
  const light = night ? NIGHT : LIGHTS.studio;
  return run(night, light, () => {
    const p = prop();
    const beats: Beat[] = act ? [{ at: 0.2, dur: 1.6, who: p.propId, do: act, dir: "right", ...(MOVERS.has(act) ? { to: { x: 0.62, y: 0.7 } } : {}), ...(o.face ? { face: o.face } : {}) }] : [];
    const d: CarDraw = { car, style: "bouncy", seed: 11 };
    const st = propState(p, beats, "side", t, { braking: o.braking ?? 0, steer: 0, rolled: t * 300 }, d);
    if (!act) st.face = o.face ?? null;
    if (o.lights) st.lights = true;
    const pen = new Pen();
    if (o.zoom) {
      pen.translate(540, 1300);
      pen.scale(o.zoom);
      pen.translate(-540, -1300);
    }
    drawProp(pen, st, "side", t, 3, o.occ ?? {}, night, d);
    return pen.out;
  });
}

describe("a detailed car's side view", () => {
  it("draws every action at five times, by day and at night, with no NaN, in the shape kinds the rasteriser knows, inside the frame", () => {
    const allowed = new Set(["rect", "circle", "ellipse", "poly", "line", "grad", "glow"]);
    for (const [name, car] of Object.entries(LOOKS)) {
      for (const night of [false, true]) {
        for (const act of ACTIONS) {
          for (const t of [0.25, 0.45, 0.8, 1.2, 1.7]) {
            const prims = draw(car, act, t, { night, face: "surprised" });
            for (const [i, pr] of prims.entries()) {
              expect(allowed.has(pr.k), `${name} ${act} ${t}: ${i} is a ${pr.k}`).toBe(true);
              expect(numbers(pr).every(Number.isFinite), `${name} ${act} ${t}: ${i} ${pr.k} has a NaN`).toBe(true);
              const e = night ? null : extent(pr);
              if (e) expect(e[0] >= FRAME.x0 && e[1] >= FRAME.y0 && e[2] <= FRAME.x1 && e[3] <= FRAME.y1, `${name} ${act} ${t}: ${i} ${pr.k} outside (${e.map(Math.round)})`).toBe(true);
            }
          }
        }
      }
    }
  });

  it("stays within the detailed look's shape budget at its busiest (lights on, braking, a flat tyre, a face)", () => {
    for (const [name, car] of Object.entries(LOOKS)) {
      let busiest = 0;
      let busiestNd = 0;
      for (const act of [null, "tyre_burst", "honk", "stop", "blink"] as (PropAction | null)[]) {
        busiest = Math.max(busiest, draw(car, act, 0.45, { braking: 1, lights: true, face: "happy" }).length);
        busiestNd = Math.max(busiestNd, draw(car, act, 0.45, { night: true, braking: 1, lights: true, face: "happy" }).length);
      }
      expect(busiest, name).toBeLessThanOrEqual(CAR_DETAIL_SHAPES);
      expect(busiestNd, name).toBeLessThanOrEqual(CAR_DETAIL_SHAPES_ND);
    }
  });

  it("keeps the plates two plain light rectangles, by day and at night", () => {
    for (const car of [SPIDER, WAGON]) {
      expect(draw(car, null, 0.5).filter((p) => "color" in p && p.color === "#f4f1ea").map((p) => p.k)).toEqual(["rect", "rect"]);
      const night = draw(car, null, 0.5, { night: true }).filter((p) => "color" in p && p.color !== "#f4f1ea" && p.k === "rect" && p.w < 12 && p.h < 24);
      expect(night.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("turns every rear lens to the brake colour while braking and leaves no tail lens", () => {
    for (const car of [SPIDER, WAGON]) {
      const brake = draw(car, null, 0.5, { night: true, braking: 1 });
      const lamps = colours(brake);
      expect(lamps.has(ND.tailCore), "tail lens left").toBe(false);
      expect(lamps.has(ND.brakeCore)).toBe(true);
      const lit = colours(draw(car, null, 0.5, { night: true, braking: 0, lights: true }));
      expect(lit.has(ND.tailCore)).toBe(true);
      expect(lit.has(ND.brakeCore)).toBe(false);
      expect(colours(draw(car, null, 0.5, { braking: 1 })).has("#ff2d2d")).toBe(true);
    }
  });

  it("Bright never draws a soft glow; night drive does when the lights are on", () => {
    for (const car of [SPIDER, WAGON]) {
      expect(draw(car, null, 0.5, { lights: true }).some((p) => p.k === "glow")).toBe(false);
      expect(draw(car, "blink", 0.5, { braking: 1, lights: true }).some((p) => p.k === "glow")).toBe(false);
      expect(draw(car, null, 0.5, { night: true, lights: true }).some((p) => p.k === "glow")).toBe(true);
    }
  });

  it("gives the riders two seats inside the body, with room for a head, on an open car and a closed one", () => {
    for (const car of [SPIDER, WAGON]) {
      let seen: { x: number; beltY: number; topY: number }[] = [];
      draw(car, null, 0.5, { occ: { side: (_pen, seats) => { seen = seats; } } });
      const g = run(false, LIGHTS.studio, () => sideShape(car));
      expect(seen.length).toBe(2);
      for (const s of seen) {
        expect(s.topY).toBeLessThanOrEqual(s.beltY - 46);
        expect(Math.abs(s.x)).toBeLessThan(g.hl);
      }
    }
  });

  it("paints the door skin again after the riders so only heads and shoulders show", () => {
    const order: string[] = [];
    const prims = draw(SPIDER, null, 0.5, { occ: { side: (pen) => { order.push("riders"); pen.rect(-5, -5, 10, 10, 2, "#abcdef"); } } });
    const mark = prims.findIndex((p) => p.k === "rect" && p.color === "#abcdef");
    expect(mark).toBeGreaterThan(0);
    const g = run(false, LIGHTS.studio, () => sideShape(SPIDER));
    // the first prim after the riders is a poly in the body's paint (the door skin: belt to crease)
    const after = prims[mark + 1]!;
    expect(after.k).toBe("poly");
    expect("color" in after && after.color).toBe("#55575a");
    expect(g.mask.length).toBeGreaterThanOrEqual(8);
    expect(order).toEqual(["riders"]);
  });

  it("draws different faces for different expressions, and none without eyes", () => {
    for (const [name, car] of [["windscreen", LOOKS.spiderWindscreenEyes!], ["headlights", LOOKS.wagonHeadEyes!]] as const) {
      const base = draw(car, null, 0.5, { face: "neutral" });
      expect(JSON.stringify(draw(car, null, 0.5, { face: "surprised" })), name).not.toEqual(JSON.stringify(base));
      expect(JSON.stringify(draw(car, null, 0.5, { face: "angry" })), name).not.toEqual(JSON.stringify(draw(car, null, 0.5, { face: "happy" })));
    }
    // a face adds prims; without eyes the same look draws fewer
    expect(draw(LOOKS.spiderWindscreenEyes!, null, 0.5, { face: "neutral" }).length).toBeGreaterThan(draw(SPIDER, null, 0.5, { face: "neutral" }).length);
    // an open car with windscreen eyes draws its door glass up
    expect(draw(LOOKS.spiderWindscreenEyes!, null, 0.5, { face: "neutral" }).filter((p) => p.k === "poly" && p.a === 0.9).length).toBe(1);
  });

  it("moves the body on its springs and turns the spokes, not the whole car", () => {
    const a = draw(SPIDER, "bounce", 0.3);
    const b = draw(SPIDER, "bounce", 0.6);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
    const idle = draw(SPIDER, null, 0.5);
    const rolling = draw(SPIDER, "move", 0.9);
    expect(rolling.length).toBeGreaterThan(0);
    expect(JSON.stringify(rolling)).not.toEqual(JSON.stringify(idle));
  });

  it("fades the fine parts out when the car is far away (fewer prims at a small size)", () => {
    const near = draw(SPIDER, null, 0.5, { zoom: 2 });
    const far = draw(SPIDER, null, 0.5, { zoom: 0.12 });
    expect(far.length).toBeLessThan(near.length);
  });

  it("draws a motorbike, a plane and a boat under the detailed drawer with no NaN", () => {
    for (const body of ["motorbike", "plane", "boat"] as const) {
      const car: CarLook = { ...SPIDER, body, detail: { v: 1 } };
      for (const night of [false, true]) {
        for (const act of [null, "move", "stop"] as (PropAction | null)[]) {
          const prims = draw(car, act, 0.6, { night, braking: 1, lights: true, face: "happy" });
          expect(prims.length, `${body}`).toBeGreaterThan(5);
          for (const p of prims) expect(numbers(p).every(Number.isFinite), `${body} ${p.k}`).toBe(true);
        }
      }
    }
  });
});
