// The detailed vehicle's side parts and wheels (CONTRACTS §45.48 section 3): every id of every list draws something
// different from its neighbour, in both palettes; counts per part; the caliper does not turn and the spokes do; Bright
// never calls glow or reads the light; Night drive paints no raw colour; a part faded out by size is dropped by the pen.
import { describe, expect, it } from "vitest";
import { grade, LIGHTS, lineUnits, ND, type Light } from "../src/stories/engine/art.ts";
import { PLATE } from "../src/stories/engine/car.ts";
import { CAR_DETAIL } from "../src/stories/engine/carDetail.ts";
import * as P from "../src/stories/engine/carParts.ts";
import { lampAt, sideShape } from "../src/stories/engine/carShape.ts";
import { wheelSide2 } from "../src/stories/engine/carWheels.ts";
import { F, withArt } from "../src/stories/engine/frame.ts";
import { prng } from "../src/stories/engine/math.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import type { CarBody, CarDetail, CarLook, Prim } from "../src/stories/engine/types.ts";

const BOX = { x0: -4000, y0: -4000, x1: 4000, y1: 4000 };
const NIGHT: Light = LIGHTS.night;

function look(detail: CarDetail = { v: 1 }, body: CarBody = "sedan", over: Partial<CarLook> = {}): CarLook {
  return {
    body, length: 1, height: 1, paint: "#8a8f98", accent: "#3b7d4f", pattern: "plain", windows: "clear",
    wheels: { style: "alloy", rim: "#c9ccd2", size: 1 }, lights: { front: "round", rear: "round" }, extra: "none",
    face: { eyes: "none", color: "#1c1842", mouth: "none" }, outline: "#17181b", ...over, detail,
  } as CarLook;
}
const D = (d: Omit<CarDetail, "v">): CarDetail => ({ v: 1, ...d });

interface Opts {
  nd?: boolean;
  size?: number;
  light?: Light;
}

/** Draws a group of parts on the look and gives the prims. */
function run(car: CarLook, fn: (c: P.PartCtx) => void, o: Opts = {}): Prim[] {
  const pen = new Pen(BOX);
  withArt(o.nd ? "night_drive" : "classic", () => {
    if (o.light) F.light = o.light;
    const g = sideShape(car);
    const S = P.styleOf(pen, 1, car, g.R, o.size ?? 3);
    fn(P.partCtx(pen, g, S));
  });
  return pen.out;
}

const ALL = (c: P.PartCtx, lamps: P.LampState = { lit: false, tailOn: false, braking: false }): void => {
  P.bodyPaint(c);
  P.stripes(c);
  P.nightTop(c);
  P.glassBack(c);
  P.glassFront(c);
  P.bodyLines(c);
  P.sidePieces(c);
  P.nightEdge(c);
  P.noseTail(c);
  P.bonnetVent(c);
  P.lamps(c, lamps);
  P.tailPieces(c);
  P.extras(c);
  P.wheels(c, 0.3, false);
};

/** Each id of the list draws something different from the one before it, in both palettes. */
function neighbours(name: string, ids: (string | number | boolean)[], make: (id: never) => CarLook, fn: (c: P.PartCtx) => void): void {
  it(`${name}: each id draws something different from its neighbour`, () => {
    for (const nd of [false, true]) {
      const outs = ids.map((id) => JSON.stringify(run(make(id as never), fn, { nd })));
      for (let i = 1; i < ids.length; i += 1) expect(outs[i], `${name} ${String(ids[i])} vs ${String(ids[i - 1])} (${nd ? "night" : "bright"})`).not.toBe(outs[i - 1]);
    }
  });
}

function bbox(p: Prim): [number, number, number, number] | null {
  switch (p.k) {
    case "circle": return [p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r];
    case "ellipse": {
      const t = (p.rot * Math.PI) / 180;
      const ex = Math.hypot(p.rx * Math.cos(t), p.ry * Math.sin(t));
      const ey = Math.hypot(p.rx * Math.sin(t), p.ry * Math.cos(t));
      return [p.x - ex, p.y - ey, p.x + ex, p.y + ey];
    }
    case "rect": return [p.x, p.y, p.x + p.w, p.y + p.h];
    case "poly":
    case "line": {
      const xs = p.pts.filter((_, i) => i % 2 === 0);
      const ys = p.pts.filter((_, i) => i % 2 === 1);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    default: return null;
  }
}
const alpha = (p: Prim): number => (p as { a?: number }).a ?? 1;
const colours = (prims: Prim[]): string[] => prims.flatMap((p) => ("color" in p ? [p.color] : []));
const numbers = (p: Prim): number[] => Object.values(p).flatMap((v) => (typeof v === "number" ? [v] : Array.isArray(v) ? (v as unknown[]).flat().filter((x): x is number => typeof x === "number") : []));

const WHEEL_SHAPES = ["steel", "cap", "straight", "split", "y", "star", "mesh", "turbine", "dish", "wire", "block"];
const FRONT_LAMPS = ["round", "twin_round", "oval", "square", "rect", "slim", "swept", "angled", "stacked", "pop_up", "strip"];
const REAR_LAMPS = ["round", "twin_round", "square", "rect", "tall", "slim", "bar", "split_bar", "wedge", "c_shape"];

describe("styleOf", () => {
  it("Bright is plain and Night drive grades; the fade is a smoothstep between two sizes", () => {
    const car = look(D({ finish: "metallic" }));
    const g = sideShape(car);
    const pen = new Pen(BOX);
    const b = withArt("classic", () => P.styleOf(pen, 1, car, g.R, 0.31));
    expect(b.nd).toBe(false);
    expect(b.t("#123456")).toBe("#123456");
    expect(b.ow).toBe(8);
    expect(b.gloss).toBe(1.15);
    expect(b.fade(0.2, 0.42)).toBeCloseTo(0.5, 5);
    expect(b.fade(0.42, 0.7)).toBe(0);
    expect(P.styleOf(pen, 1, car, g.R, 5).fade(0.42, 0.7)).toBe(1);
    const n = withArt("night_drive", () => {
      F.light = NIGHT;
      return { s: P.styleOf(pen, 2, car, g.R, 3), ow: lineUnits(pen, 2.6) / 2, g: grade("#123456", NIGHT) };
    });
    expect(n.s.nd).toBe(true);
    expect(n.s.ow).toBeCloseTo(n.ow, 6);
  });

  it("the finish sets the gloss", () => {
    const pen = new Pen(BOX);
    const gloss = (finish: "gloss" | "satin" | "matte" | "metallic") => {
      const car = look(D({ finish }));
      return P.styleOf(pen, 1, car, sideShape(car).R, 3).gloss;
    };
    expect([gloss("gloss"), gloss("metallic"), gloss("satin"), gloss("matte")]).toEqual([1, 1.15, 0.55, 0.25]);
  });
});

describe("wheels", () => {
  neighbours("wheel shape", WHEEL_SHAPES, (s) => look(D({ wheels: { shape: s as never } })), (c) => P.wheels(c, 0.3, false));
  neighbours("brake disc", ["none", "plain", "drilled", "ceramic"], (d) => look(D({ brakes: { disc: d as never, caliper: "#ffd21f" } })), (c) => P.wheels(c, 0.3, false));
  neighbours("spokes", [3, 4, 5, 6, 8, 12, 24], (n) => look(D({ wheels: { shape: "straight", spokes: n as never } })), (c) => P.wheels(c, 0.3, false));
  neighbours("tyre", [12, 22, 40, 60], (t) => look(D({ wheels: { tyre: t as never } })), (c) => P.wheels(c, 0.3, false));
  neighbours("lip", [0, 100], (l) => look(D({ wheels: { lip: l as never } })), (c) => P.wheels(c, 0.3, false));
  neighbours("wall", ["black", "white"], (w) => look(D({ wheels: { wall: w as never } })), (c) => P.wheels(c, 0.3, false));
  neighbours("hub disc", [false, true], (h) => look(D(h ? { wheels: { hub: "#ff00aa" } } : {})), (c) => P.wheels(c, 0.3, false));
  neighbours("staggered wheels", [false, true], (s) => look(D({ wheels: s ? { rearD: 60 } : {} })), (c) => P.wheels(c, 0.3, false));

  it("counts: 8 prims a wheel at most (steel and cap fewer; wire adds its small chrome hub)", () => {
    for (const nd of [false, true]) {
      for (const shape of WHEEL_SHAPES) {
        const car = look(D({ wheels: { shape: shape as never }, brakes: { disc: "plain", caliper: "#ffd21f" } }));
        const n = run(car, (c) => P.wheels(c, 0.3, false), { nd }).length;
        if (shape === "steel") expect(n, `steel ${nd}`).toBeLessThanOrEqual(2 * 4);
        else if (shape === "cap") expect(n, `cap ${nd}`).toBeLessThanOrEqual(2 * 5);
        else expect(n, `${shape} ${nd}`).toBeLessThanOrEqual(2 * (shape === "wire" ? 9 : 8));
        expect(n).toBeGreaterThanOrEqual(2 * 3);
      }
    }
  });

  it("the caliper and the disc do not turn, the spokes do", () => {
    const car = look(D({ wheels: { shape: "split", spokes: 5 }, brakes: { disc: "ceramic", caliper: "#ffd21f" } }));
    const a = run(car, (c) => P.wheels(c, 0, false));
    const b = run(car, (c) => P.wheels(c, 1.3, false));
    const only = (l: Prim[], col: string) => l.filter((p) => "color" in p && p.color === col);
    expect(only(a, "#ffd21f")).toHaveLength(2);
    expect(only(b, "#ffd21f")).toEqual(only(a, "#ffd21f"));
    expect(only(b, "#5d5a55")).toEqual(only(a, "#5d5a55"));
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
    const spokes = (l: Prim[]) => l.filter((p) => p.k === "poly" && p.color === "#c9ccd2");
    expect(spokes(a)).toHaveLength(2);
    expect(spokes(b)).not.toEqual(spokes(a));
  });

  it("a steel wheel's holes and a block tyre's tread turn", () => {
    const steel = look(D({ wheels: { shape: "steel" } }));
    expect(JSON.stringify(run(steel, (c) => P.wheels(c, 0.1, false)))).not.toBe(JSON.stringify(run(steel, (c) => P.wheels(c, 0.2, false))));
    const block = look(D({ wheels: { shape: "block", tyre: 44 } }));
    expect(JSON.stringify(run(block, (c) => P.wheels(c, 0.1, false)))).not.toBe(JSON.stringify(run(block, (c) => P.wheels(c, 0.2, false))));
  });

  it("the caliper sits behind the axle on the front wheel and ahead of it on the rear", () => {
    const car = look(D({ brakes: { disc: "plain", caliper: "#ffd21f" } }));
    const prims = run(car, (c) => P.wheels(c, 0, false));
    const g = sideShape(car);
    const cal = prims.filter((p) => p.k === "poly" && p.color === "#ffd21f") as Extract<Prim, { k: "poly" }>[];
    const [rear, front] = [cal[0]!, cal[1]!];
    const cx = (p: Extract<Prim, { k: "poly" }>) => p.pts.filter((_, i) => i % 2 === 0).reduce((s, v) => s + v, 0) / (p.pts.length / 2);
    expect(cx(rear)).toBeGreaterThan(g.arch[0]!.x);
    expect(cx(front)).toBeLessThan(g.arch[1]!.x);
  });

  it("a flat tyre squashes the front wheel to 0.72 and leaves the rear round", () => {
    const car = look(D({}));
    const round = run(car, (c) => P.wheels(c, 0, false));
    const flat = run(car, (c) => P.wheels(c, 0, true));
    expect(round.every((p) => p.k !== "ellipse")).toBe(true);
    const ratios = (flat.filter((p) => p.k === "ellipse") as Extract<Prim, { k: "ellipse" }>[]).map((p) => Math.min(p.rx, p.ry) / Math.max(p.rx, p.ry));
    expect(ratios.length).toBeGreaterThan(2);
    expect(Math.min(...ratios)).toBeCloseTo(0.72, 1);
    // the squashed wheel still stands on the ground: its lowest point is the round one's
    const low = (l: Prim[]) => Math.max(...l.map((p) => (bbox(p) ?? [0, 0, 0, -1e9])[3]));
    expect(low(flat)).toBeCloseTo(low(round), 0);
  });

  it("wheelSide2 draws the resolved wheel for any look, with or without detail, in either style", () => {
    for (const nd of [false, true]) {
      for (const d of [undefined, D({ wheels: { shape: "mesh" } })]) {
        const car = { ...look(), detail: d } as CarLook;
        const pen = new Pen(BOX);
        withArt(nd ? "night_drive" : "classic", () => {
          wheelSide2(pen, -200, -50, 50, 0.4, false, car, "#101010", 6);
          wheelSide2(pen, 200, -50, 50, 0.4, true, car, "#101010", 6);
        });
        expect(pen.out.length).toBeGreaterThan(8);
        expect(pen.out.every((p) => numbers(p).every(Number.isFinite))).toBe(true);
      }
    }
  });
});

describe("lamps", () => {
  const frontOf = (shape: string, over: Partial<CarDetail["lights"]> = {}) => look(D({ lights: { front: { shape: shape as never, ...(over?.front ?? {}) }, rear: { shape: "round" } } }));
  const rearOf = (shape: string) => look(D({ lights: { front: { shape: "round" }, rear: { shape: shape as never } } }));
  neighbours("front lamp shape", FRONT_LAMPS, (s) => frontOf(s as string), (c) => P.lamps(c, { lit: false, tailOn: false, braking: false }));
  neighbours("front lamp shape (lit)", FRONT_LAMPS, (s) => frontOf(s as string), (c) => P.lamps(c, { lit: true, tailOn: true, braking: false }));
  neighbours("daytime light", ["none", "line", "hook", "ring", "dots", "brow"], (d) => look(D({ lights: { front: { shape: "round", drl: d as never } } })), (c) => P.lamps(c, { lit: true, tailOn: true, braking: false }));
  neighbours("rear lamp shape", REAR_LAMPS, (s) => rearOf(s as string), (c) => P.lamps(c, { lit: false, tailOn: false, braking: false }));
  neighbours("front lens", ["clear", "yellow", "smoked"], (l) => look(D({ lights: { front: { lens: l as never } } })), (c) => P.lamps(c, { lit: false, tailOn: false, braking: false }));
  neighbours("rear lens", ["red", "clear", "smoked"], (l) => look(D({ lights: { rear: { lens: l as never } } })), (c) => P.lamps(c, { lit: false, tailOn: false, braking: false }));

  it("the lamps return lampAt's centres, and the lens covers them", () => {
    for (const f of FRONT_LAMPS) {
      for (const r of REAR_LAMPS) {
        const car = look(D({ lights: { front: { shape: f as never }, rear: { shape: r as never } } }));
        const g = sideShape(car);
        let got: { front: [number, number]; rear: [number, number] } | undefined;
        const prims = run(car, (c) => {
          got = P.lamps(c, { lit: false, tailOn: false, braking: false });
        });
        expect(got!.front).toEqual(lampAt(g, "front"));
        expect(got!.rear).toEqual(lampAt(g, "rear"));
        const near = (pt: [number, number], tol: number) => prims.some((p) => {
          const b = bbox(p);
          return b !== null && pt[0] >= b[0] - tol && pt[0] <= b[2] + tol && pt[1] >= b[1] - tol && pt[1] <= b[3] + tol;
        });
        expect(near(got!.front, f === "swept" ? 0.05 * g.tall : 1), `front ${f}`).toBe(true);
        expect(near(got!.rear, 1), `rear ${r}`).toBe(true);
      }
    }
  });

  it("braking turns every rear lens brakeCore and nothing stays tailCore; the tail lamp is tailCore otherwise", () => {
    for (const r of REAR_LAMPS) {
      const car = look(D({ lights: { rear: { shape: r as never } } }));
      const brake = run(car, (c) => P.lamps(c, { lit: true, tailOn: true, braking: true }), { nd: true, light: NIGHT });
      expect(colours(brake), r).toContain(ND.brakeCore);
      expect(colours(brake), r).not.toContain(ND.tailCore);
      const tail = run(car, (c) => P.lamps(c, { lit: true, tailOn: true, braking: false }), { nd: true, light: NIGHT });
      expect(colours(tail), r).toContain(ND.tailCore);
      const dark = run(car, (c) => P.lamps(c, { lit: false, tailOn: false, braking: false }), { nd: true, light: NIGHT });
      expect(colours(dark), r).not.toContain(ND.tailCore);
      expect(colours(dark), r).not.toContain(ND.brakeCore);
      expect(colours(run(car, (c) => P.lamps(c, { lit: false, tailOn: false, braking: true }))), r).toContain("#ff2d2d");
    }
  });

  it("the headlight is headCore only when the lights are on", () => {
    const car = look();
    expect(colours(run(car, (c) => P.lamps(c, { lit: true, tailOn: true, braking: false }), { nd: true }))).toContain(ND.headCore);
    expect(colours(run(car, (c) => P.lamps(c, { lit: false, tailOn: false, braking: false }), { nd: true }))).not.toContain(ND.headCore);
  });
});

describe("body, glass and lines", () => {
  neighbours("arches", ["round", "square", "flare", "clad"], (a) => look(D({ arches: a as never })), (c) => P.bodyPaint(c));
  neighbours("skirts", ["none", "lip", "deep", "boards"], (s) => look(D({ side: { skirts: s as never } })), (c) => P.bodyPaint(c));
  neighbours("splitter", ["none", "lip", "blade"], (s) => look(D({ front: { splitter: s as never } })), (c) => P.bodyPaint(c));
  neighbours("diffuser", ["none", "fins", "deep"], (s) => look(D({ rear: { diffuser: s as never } })), (c) => {
    P.bodyPaint(c);
    P.tailPieces(c);
  });
  neighbours("two-tone", ["none", "roof", "split", "lower", "bonnet"], (t) => look(D(t === "none" ? {} : { twoTone: t as never })), (c) => P.bodyPaint(c));
  neighbours("roof", ["closed", "open", "targa", "soft_top", "sunroof", "glass"], (t) => look(D({ roof: { type: t as never } })), (c) => {
    P.glassBack(c);
    P.glassFront(c);
  });
  neighbours("roof colour", [false, true], (t) => look(D(t ? { roof: { color: "#ff8800" } } : {})), (c) => P.bodyPaint(c));
  neighbours("stripe layout", ["none", "centre", "twin", "offset", "side", "sill", "pin"], (s) => look(D({ stripe: { layout: s as never, color: "#ff8800", width: 70 } })), (c) => P.stripes(c));
  neighbours("stripe width", [0, 50, 100], (w) => look(D({ stripe: { layout: "centre", width: w as never } })), (c) => P.stripes(c));
  neighbours("doors", [0, 1, 2, 3], (n) => look(D({ side: { doors: n as never } })), (c) => P.bodyLines(c));
  neighbours("handles", ["none", "bar", "flush", "chrome"], (h) => look(D({ side: { doors: 2, handles: h as never } })), (c) => P.bodyLines(c));
  neighbours("crease", ["none", "level", "wedge", "double"], (h) => look(D({ side: { crease: h as never } })), (c) => P.bodyLines(c));
  neighbours("fuel cap", [false, true], (f) => look(D({ side: { fuelCap: f as never } })), (c) => P.bodyLines(c));
  neighbours("finish", ["gloss", "metallic", "satin", "matte"], (f) => look(D({ finish: f as never, side: { crease: "level" } })), (c) => P.bodyLines(c));
  neighbours("side intake", ["none", "scoop", "gill", "slats", "duct"], (s) => look(D({ side: { intake: s as never } })), (c) => P.sidePieces(c));
  neighbours("side intake place", [30, 66, 90], (x) => look(D({ side: { intake: "scoop", intakeX: x as never } })), (c) => P.sidePieces(c));
  neighbours("mirror", ["none", "ear", "stalk", "square"], (m) => look(D({ side: { mirror: m as never } })), (c) => P.sidePieces(c));
  neighbours("rub strip", [false, true], (r) => look(D({ side: { rubStrip: r as never } })), (c) => P.sidePieces(c));
  neighbours("grille", ["none", "slot", "bars", "slats", "mesh", "oval", "tall", "twin"], (g) => look(D({ front: { grille: g as never } })), (c) => P.noseTail(c));
  neighbours("front intake", ["none", "wide", "split3", "twin", "smile"], (g) => look(D({ front: { intake: g as never } })), (c) => P.noseTail(c));
  neighbours("bumper", ["body", "black", "chrome"], (b) => look(D({ front: { bumper: b as never } })), (c) => P.noseTail(c));
  neighbours("rear bumper", ["body", "black", "chrome"], (b) => look(D({ rear: { bumper: b as never } })), (c) => P.noseTail(c));
  neighbours("fog lamps", [false, true], (f) => look(D({ front: { fog: f as never } })), (c) => P.noseTail(c));
  neighbours("bonnet vent", ["none", "scoop", "bulge", "vents", "duct"], (v) => look(D({ bonnet: { vent: v as never } })), (c) => P.bonnetVent(c));
  neighbours("spoiler", ["none", "lip", "ducktail", "wing", "big_wing", "roof"], (s) => look(D({ rear: { spoiler: s as never } })), (c) => P.tailPieces(c));
  neighbours("exhaust", ["none", "single", "twin", "quad", "centre", "high", "side", "stack"], (e) => look(D({ rear: { exhaust: e as never } })), (c) => P.tailPieces(c));

  it("every extra draws something, and no two extras draw the same", () => {
    const ids = (CAR_DETAIL["extras"] as { l: string[] }).l;
    const none = JSON.stringify(run(look(D({ extras: [] })), (c) => P.extras(c)));
    const outs = ids.map((e) => JSON.stringify(run(look(D({ extras: [e as never] })), (c) => P.extras(c))));
    ids.forEach((e, i) => expect(outs[i], e).not.toBe(none));
    expect(new Set(outs).size).toBe(ids.length);
  });

  it("the classic rack and box and the roof's rails draw on a closed roof and are skipped on an open one", () => {
    const rails = (open: boolean) => run(look(D({ roof: { type: open ? "open" : "closed", rails: true } })), (c) => P.extras(c)).length;
    expect(rails(false)).toBeGreaterThan(rails(true));
    for (const extra of ["roof_rack", "roof_box"] as const) {
      const closed = run(look(D({}), "sedan", { extra }), (c) => P.extras(c)).length;
      const open = run(look(D({ roof: { type: "open" } }), "sedan", { extra }), (c) => P.extras(c)).length;
      expect(closed).toBeGreaterThan(open);
    }
  });

  it("the plates are two plain rects and no part draws text or a mark", () => {
    const car = look(D({ extras: ["spare_wheel", "light_bar", "ladder"] }));
    const prims = run(car, (c) => ALL(c));
    expect(prims.filter((p) => p.k === "rect" && p.color === PLATE)).toHaveLength(2);
    expect(prims.every((p) => ["rect", "circle", "ellipse", "poly", "line"].includes(p.k))).toBe(true);
  });

  it("a soft top paints the roof over the glass in its own colour", () => {
    const prims = run(look(D({ roof: { type: "soft_top", color: "#2d2b2a" } })), (c) => P.glassFront(c));
    expect(colours(prims)).toContain("#2d2b2a");
  });

  it("the exhaust puff starts by the exhaust id", () => {
    const ids = ["single", "centre", "high", "side", "stack"] as const;
    const at = ids.map((e) => P.exhaustAt(sideShape(look(D({ rear: { exhaust: e } })))));
    expect(new Set(at.map((v) => v.join(","))).size).toBe(ids.length);
    for (const v of at) expect(v.every(Number.isFinite)).toBe(true);
  });
});

describe("the two palettes", () => {
  const SPIDER = look(
    D({
      toon: 30,
      roof: { type: "open", hoops: "twin" },
      wheels: { shape: "split", spokes: 5, tyre: 22, lip: 10 },
      brakes: { disc: "ceramic", caliper: "#ffd21f" },
      lights: { front: { shape: "swept", drl: "line" }, rear: { shape: "round" } },
      front: { intake: "split3", splitter: "blade" },
      bonnet: { vent: "duct" },
      side: { intake: "scoop", skirts: "lip", doors: 1, handles: "flush", crease: "wedge", mirror: "stalk" },
      rear: { diffuser: "fins", exhaust: "high", spoiler: "ducktail" },
      stripe: { layout: "centre", color: "#111111", width: 60 },
      finish: "satin",
    }),
    "sports",
    { paint: "#55575a", accent: "#111111", pattern: "racing_stripes", wheels: { style: "sport", rim: "#1a1a1a", size: 1 }, lights: { front: "slim", rear: "round" } },
  );
  const BUSY = look(
    D({
      roof: { rails: true },
      wheels: { shape: "mesh", wall: "white", hub: "#ff00aa" },
      brakes: { disc: "drilled", caliper: "#d4a017" },
      lights: { front: { shape: "round", drl: "ring" } },
      front: { grille: "bars", bumper: "chrome", fog: true },
      side: { doors: 2, handles: "chrome", crease: "double", mirror: "square", rubStrip: true, fuelCap: true, intake: "slats" },
      rear: { exhaust: "twin", spoiler: "wing", bumper: "chrome" },
      arches: "flare",
      stripe: { layout: "twin" },
      extras: ["antenna", "light_bar", "mudflaps", "tow_hook", "shark_fin", "wing_lamps"],
    }),
    "suv",
  );

  it("the owner's open two-seater draws in about fifty prims in Bright and fifty-five in Night drive", () => {
    expect(run(SPIDER, (c) => ALL(c)).length).toBeLessThanOrEqual(56);
    expect(run(SPIDER, (c) => ALL(c), { nd: true }).length).toBeLessThanOrEqual(62);
  });

  it("Bright draws no glow and does not read the light", () => {
    for (const car of [SPIDER, BUSY]) {
      const studio = run(car, (c) => ALL(c, { lit: true, tailOn: true, braking: true }));
      const lit = run(car, (c) => ALL(c, { lit: true, tailOn: true, braking: true }), { light: NIGHT });
      expect(studio.some((p) => p.k === "glow")).toBe(false);
      expect(JSON.stringify(lit)).toBe(JSON.stringify(studio));
    }
  });

  it("Night drive paints no raw colour of the look", () => {
    const RAW = { paint: "#3a6b35", accent: "#7a2b9d", rim: "#2d9bb0", caliper: "#d4a017", trim: "#4b3b8c", mirror: "#a0522d", roof: "#2e8b57", stripe: "#b22222", hub: "#6a5acd", seat: "#8b4513" };
    const car = look(
      D({
        roof: { color: RAW.roof, rails: true },
        wheels: { shape: "turbine", hub: RAW.hub, wall: "white" },
        brakes: { disc: "plain", caliper: RAW.caliper },
        trim: RAW.trim,
        mirrorColor: RAW.mirror,
        stripe: { layout: "centre", color: RAW.stripe },
        side: { skirts: "deep", mirror: "stalk", crease: "double", intake: "scoop", doors: 2, handles: "chrome", rubStrip: true },
        front: { splitter: "blade", bumper: "chrome", grille: "bars", fog: true },
        rear: { diffuser: "fins", spoiler: "big_wing", exhaust: "quad", bumper: "black" },
        arches: "flare",
        extras: ["light_bar", "spare_wheel", "bull_bar", "wing_lamps", "roof_scoop"],
        cabin: { seat: RAW.seat },
      }),
      "sedan",
      { paint: RAW.paint, accent: RAW.accent, wheels: { style: "alloy", rim: RAW.rim, size: 1 } },
    );
    const raw = new Set(Object.values(RAW));
    for (const state of [{ lit: false, tailOn: false, braking: false }, { lit: true, tailOn: true, braking: true }]) {
      const used = colours(run(car, (c) => ALL(c, state), { nd: true, light: NIGHT }));
      for (const col of used) expect(raw.has(col), `raw ${col}`).toBe(false);
    }
    // and the same look in Bright keeps them (so the check above is not vacuous)
    const bright = new Set(colours(run(car, (c) => ALL(c))));
    for (const col of [RAW.paint, RAW.caliper, RAW.mirror, RAW.trim, RAW.stripe]) expect(bright.has(col), col).toBe(true);
  });

  it("a part faded out by size is dropped by the pen, and the parts fade in with it", () => {
    const car = look(D({ brakes: { disc: "plain", caliper: "#ffd21f" }, side: { doors: 1, handles: "bar", crease: "level", mirror: "ear" } }));
    const cal = (size: number) => run(car, (c) => P.wheels(c, 0, false), { size }).filter((p) => "color" in p && p.color === "#ffd21f");
    expect(cal(0.05)).toHaveLength(0);
    expect(cal(3)).toHaveLength(2);
    const mid = cal(0.31);
    expect(mid).toHaveLength(2);
    expect(alpha(mid[0]!)).toBeGreaterThan(0.2);
    expect(alpha(mid[0]!)).toBeLessThan(0.9);
    const counts = [0.05, 0.15, 0.3, 0.5, 0.8, 3].map((s) => run(car, (c) => ALL(c), { size: s }).length);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]! + 6);
    // the always-on parts stay: the outline, the glass, the lamps, the tyres
    const far = run(car, (c) => ALL(c), { size: 0.05 });
    expect(far.length).toBeGreaterThan(20);
  });

  it("the fine door lines and the handle show only at the fine tier", () => {
    const car = look(D({ side: { doors: 1, handles: "bar", crease: "level" } }));
    const at = (size: number) => run(car, (c) => P.bodyLines(c), { size }).filter((p) => p.k === "line" || (p.k === "poly" && alpha(p) === 1)).length;
    expect(at(0.1)).toBe(0);
    expect(at(3)).toBeGreaterThan(0);
  });
});

describe("every look, every id (a fuzz)", () => {
  const BODIES: CarBody[] = ["hatchback", "sedan", "estate", "suv", "pickup", "van", "sports", "compact", "bus", "motorbike", "plane", "boat"];

  function randomDetail(r: () => number): CarDetail {
    const d: Record<string, unknown> = { v: 1 };
    const set = (path: string, v: unknown): void => {
      const parts = path.split(".");
      let o = d;
      for (const k of parts.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
      o[parts[parts.length - 1]!] = v;
    };
    for (const [path, rule] of Object.entries(CAR_DETAIL)) {
      if (path.startsWith("profile") || path === "v" || r() < 0.3) continue;
      if ("e" in rule) set(path, rule.e[Math.floor(r() * rule.e.length)]);
      else if ("n" in rule) set(path, rule.n[0] + Math.floor(r() * (rule.n[1] - rule.n[0] + 1)));
      else if ("c" in rule) set(path, `#${Math.floor(r() * 0xffffff).toString(16).padStart(6, "0")}`);
      else if ("b" in rule) set(path, r() < 0.5);
      else if ("l" in rule) set(path, rule.l.filter(() => r() < 0.4).slice(0, rule.max));
    }
    return d as unknown as CarDetail;
  }

  it("draws finite, boxed prims in both styles at every size, and never throws", () => {
    const r = prng(11);
    for (let n = 0; n < 90; n += 1) {
      const body = BODIES[n % BODIES.length]!;
      const car = look(randomDetail(r), body, { pattern: (["plain", "two_tone", "stripe", "racing_stripes"] as const)[n % 4], extra: (["none", "spoiler", "roof_rack", "roof_box"] as const)[n % 4] });
      const g = sideShape(car);
      for (const nd of [false, true]) {
        for (const size of [0.1, 0.3, 3]) {
          const prims = run(car, (c) => ALL(c, { lit: n % 2 === 0, tailOn: n % 3 === 0, braking: n % 5 === 0 }), { nd, size, light: nd ? NIGHT : undefined });
          expect(prims.length).toBeGreaterThan(0);
          for (const p of prims) {
            expect(numbers(p).every(Number.isFinite), `${body} ${JSON.stringify(car.detail)}`).toBe(true);
            const b = bbox(p);
            if (b !== null) {
              expect(b[0]).toBeGreaterThan(-g.hl - 150);
              expect(b[2]).toBeLessThan(g.hl + 150);
              expect(b[1]).toBeGreaterThan(-1.7 * g.tall - 60);
              expect(b[3]).toBeLessThan(80);
            }
          }
        }
      }
    }
  });

  it("a motorbike, a plane or a boat gets only its wheels (and the outline) from the parts", () => {
    for (const body of ["motorbike", "plane", "boat"] as const) {
      const car = look(D({ side: { doors: 2, intake: "scoop" }, rear: { spoiler: "wing" }, extras: ["bull_bar", "ladder"] }), body);
      const prims = run(car, (c) => {
        P.bodyPaint(c);
        P.stripes(c);
        P.glassBack(c);
        P.glassFront(c);
        P.bodyLines(c);
        P.sidePieces(c);
        P.noseTail(c);
        P.bonnetVent(c);
        P.tailPieces(c);
        P.extras(c);
      });
      expect(prims).toHaveLength(2);
    }
    const bike = run(look(D({}), "motorbike"), (c) => P.wheels(c, 0, false));
    expect(bike.length).toBeGreaterThan(8);
    expect(run(look(D({}), "boat"), (c) => P.wheels(c, 0, false))).toHaveLength(0);
  });
});
