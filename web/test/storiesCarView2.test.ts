// Clips Funded: the detailed vehicle's front and back views (CONTRACTS §45.48 section 2.8, carView2.ts): the box test of
// today at w 24 and 300, the prim budgets by size (alpha tiers), the lamps by shape, the back being the same for every
// face, one side showing moving one edge only, braking, the plate, and both light paths (night drive's glows, Bright's discs).
import { describe, expect, it } from "vitest";
import { grade, LIGHTS, ND, withWarm, type Light } from "../src/stories/engine/art.ts";
import { classicLook, GLASS_ND, PLATE, TAIL_OFF } from "../src/stories/engine/car.ts";
import { endLamps, END_FINE, END_MEDIUM } from "../src/stories/engine/carView2.ts";
import { drawCarView, type CarViewOpts } from "../src/stories/engine/carView.ts";
import { F, inFrame } from "../src/stories/engine/frame.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import type { CarBody, CarDetail, CarLook, Expression, Prim } from "../src/stories/engine/types.ts";

const NIGHT = withWarm(LIGHTS.night, 1);
const ALLOWED = new Set(["rect", "circle", "ellipse", "poly", "line", "grad", "glow"]);
const WHEELED: CarBody[] = ["hatchback", "sedan", "estate", "suv", "pickup", "van", "sports", "compact", "bus"];

function look(body: CarBody, detail: CarDetail | null = { v: 1 }, extra: Partial<CarLook> = {}): CarLook {
  return {
    body, length: 1, height: 1, paint: "#8a8f98", accent: "#1c1d20", pattern: "plain", windows: "clear",
    wheels: { style: "alloy", rim: "#c9ccd2", size: 1 }, lights: { front: "round", rear: "round" }, extra: "none",
    face: { eyes: "none", color: "#1c1842", mouth: "none" }, outline: "#17181b", ...extra, ...(detail !== null ? { detail } : {}),
  } as CarLook;
}

/** The owner's kind of vehicle: a grey open two-seater with a black centre stripe (made-up numbers, no make or model). */
const DART: CarDetail = {
  v: 1,
  toon: 30,
  profile: { body: "sports", lh: 379, wh: 162, tipH: 30, noseX: 3, noseH: 42, noseR: 20, chinH: 9, cowlX: 33, cowlH: 71, bonnet: 55, headX: 46, headH: 100, peakX: 50, roofX: 62, roofH: 97, deckX: 80, deckH: 84, tailX: 97, tailH: 81, rumpH: 15, sillH: 10, axF: 23, axR: 81, wheelD: 57, archGap: 9, beltH: 72, beltRise: 2, soft: 55, pillarX: 60, glassX: 62, panes: 1, roofW: 62, taperF: 22, taperR: 8 },
  roof: { type: "open", hoops: "twin" },
  lights: { front: { shape: "swept", drl: "line" }, rear: { shape: "round" } },
  front: { grille: "none", intake: "split3", splitter: "blade", bumper: "body" },
  bonnet: { vent: "duct" },
  rear: { diffuser: "fins", exhaust: "high", spoiler: "ducktail" },
  stripe: { layout: "centre", color: "#111111", width: 60 },
  finish: "satin",
};
const dart = (): CarLook => look("sports", DART, { paint: "#55575a", accent: "#111111", pattern: "racing_stripes", outline: "#141414" });

const FRONT_SHAPES = ["round", "twin_round", "oval", "square", "rect", "slim", "swept", "angled", "stacked", "pop_up", "strip"] as const;
const REAR_SHAPES = ["round", "twin_round", "square", "rect", "tall", "slim", "bar", "split_bar", "wedge", "c_shape"] as const;

const base = (extra: Partial<CarViewOpts> = {}): CarViewOpts => ({ x: 540, y: 1200, w: 300, side: 0, light: NIGHT, braking: 0, lights: false, blink: 0, face: null, t: 0.5, seed: 3, ...extra });

function draw(car: CarLook, view: "back" | "front", o: CarViewOpts, art: "night_drive" | "classic" = "night_drive"): Prim[] {
  const pen = new Pen();
  inFrame({ width: 1080, height: 1920, art }, () => {
    F.light = o.light as Light;
    drawCarView(pen, car, view, o);
  });
  return pen.out;
}

function numbers(p: Prim): number[] {
  return Object.values(p).flatMap((v) => (typeof v === "number" ? [v] : Array.isArray(v) ? v.flat().filter((x): x is number => typeof x === "number") : []));
}

function extent(p: Prim): [number, number, number, number] | null {
  if (p.k === "circle") return [p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r];
  if (p.k === "ellipse" || p.k === "glow") {
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

function problems(prims: Prim[], box: { x0: number; y0: number; x1: number; y1: number }): string[] {
  const out: string[] = [];
  for (const [i, p] of prims.entries()) {
    if (!ALLOWED.has(p.k)) out.push(`${i}: ${p.k} is not a car shape`);
    if (numbers(p).some((v) => !Number.isFinite(v))) out.push(`${i}: ${p.k} has a NaN`);
    const e = extent(p);
    if (e && (e[0] < box.x0 || e[1] < box.y0 || e[2] > box.x1 || e[3] > box.y1)) out.push(`${i}: ${p.k} reaches outside the box (${e.map((v) => Math.round(v)).join(", ")})`);
  }
  return out;
}

const alphaOf = (p: Prim): number => ("a" in p && typeof p.a === "number" ? p.a : 1);
const withColour = (prims: Prim[], c: string): Prim[] => prims.filter((p) => "color" in p && p.color === c);
const polysOf = (prims: Prim[], c: string): Prim[] => withColour(prims, c).filter((p) => p.k === "poly");

describe("the detailed front and back views", () => {
  it("every body and the owner's kind draws inside the box of today, at w 24 and 300, in every side, light and state", () => {
    const cars = [...WHEELED.map((b) => look(b)), dart()];
    for (const car of cars) {
      for (const v of ["back", "front"] as const) {
        for (const side of [-1, -0.4, 0, 0.3, 1]) {
          for (const light of [NIGHT, LIGHTS.day, LIGHTS.cabin]) {
            for (const [braking, lights, blink] of [[0, false, 0], [1, true, 0], [0.6, false, 1]] as [number, boolean, number][]) {
              for (const w of [24, 300]) {
                const o = base({ side, light, braking, lights, blink, face: car === cars[0] ? "happy" : null, w, bloom: blink ? 1.8 : 1 });
                const prims = draw(car, v, o);
                const box = { x0: o.x - 1.05 * w - 8, y0: o.y - 1.6 * w - 8, x1: o.x + 1.05 * w + 8, y1: o.y + 0.3 * w + 8 };
                expect(problems(prims, box), `${car.body} ${v} side ${side} ${braking} ${lights} ${blink} ${w}`).toEqual([]);
              }
            }
          }
        }
      }
    }
  });

  it("a face on the car stays inside the box and within its budget, headlights and windscreen eyes, every expression", () => {
    const faces: Expression[] = ["happy", "angry", "surprised", "sad"];
    for (const eyes of ["windscreen", "headlights"] as const) {
      for (const body of ["sedan", "sports", "bus"] as CarBody[]) {
        const car = look(body, body === "sports" ? DART : { v: 1 }, { face: { eyes, color: "#1c1842", mouth: "grille" } });
        for (const face of faces) {
          for (const w of [24, 300]) {
            const prims = draw(car, "front", base({ w, face, lights: true, blink: 0.4 }));
            const box = { x0: 540 - 1.05 * w - 8, y0: 1200 - 1.6 * w - 8, x1: 540 + 1.05 * w + 8, y1: 1200 + 0.3 * w + 8 };
            expect(problems(prims, box), `${body} ${eyes} ${face} ${w}`).toEqual([]);
          }
        }
      }
    }
  });

  it("is a different drawing from the classic view, and a look without detail is the classic view untouched", () => {
    const car = look("sedan");
    const classic = look("sedan", null);
    const a = draw(car, "front", base());
    const b = draw(classic, "front", base());
    expect(a).not.toEqual(b);
    // the classic path is what it was: drawing the plain look twice is the same, and it ignores everything of detail
    expect(draw(classic, "front", base())).toEqual(b);
  });

  it("a bike, a plane and a boat with a detail keep their classic view (they have no outline of their own)", () => {
    for (const body of ["motorbike", "plane", "boat"] as CarBody[]) {
      const car = look(body, { v: 1 });
      const plain = look(body, null);
      for (const v of ["back", "front"] as const) expect(draw(car, v, base()), `${body} ${v}`).toEqual(draw(classicLook(car), v, base()));
      expect(draw(plain, "back", base()).length).toBeGreaterThan(5);
    }
  });
});

describe("level of detail (alpha tiers)", () => {
  const busy = (car: CarLook, v: "back" | "front", w: number, face: Expression | null = null): number => {
    let most = 0;
    for (const [braking, lights, blink] of [[0, false, 0], [1, true, 0], [0.6, true, 1]] as [number, boolean, number][]) {
      for (const light of [NIGHT, LIGHTS.day]) most = Math.max(most, draw(car, v, base({ w, braking, lights, blink, light, face, side: 0.5 })).length);
    }
    return most;
  };
  const eyed = (body: CarBody, detail: CarDetail = { v: 1 }) => look(body, detail, { face: { eyes: "windscreen", color: "#1c1842", mouth: "grille" } });
  const fullLook = (): CarLook =>
    look("suv", {
      v: 1,
      roof: { type: "closed", rails: true },
      lights: { front: { shape: "round", drl: "dots" }, rear: { shape: "c_shape" } },
      front: { grille: "slats", intake: "twin", splitter: "blade", bumper: "chrome", fog: true },
      bonnet: { vent: "scoop" },
      rear: { diffuser: "fins", exhaust: "quad", spoiler: "wing", bumper: "chrome" },
      stripe: { layout: "twin", width: 50 },
      extras: ["bull_bar", "spare_wheel", "light_bar", "antenna", "tow_hook", "ladder"],
    });

  it("a far car (w = 24) draws at most 34 shapes, as every car always did, and a near one at most 64", () => {
    const cars = [...WHEELED.map((b) => look(b)), dart(), fullLook(), eyed("sedan"), eyed("sports", DART)];
    for (const car of cars) {
      for (const v of ["back", "front"] as const) {
        const face: Expression | null = car.face.eyes === "none" ? null : "happy";
        expect(busy(car, v, 24, face), `${car.body} ${v} far`).toBeLessThanOrEqual(34);
        expect(busy(car, v, 300, face), `${car.body} ${v} 300`).toBeLessThanOrEqual(64);
        expect(busy(car, v, 420, face), `${car.body} ${v} near`).toBeLessThanOrEqual(64);
      }
    }
  });

  it("the tiers come in with size: nothing fine at 100, the fine parts only past the medium ones", () => {
    const car = fullLook();
    const counts = [24, 90, 150, 260, 330, 420].map((w) => draw(car, "front", base({ w })).length);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]!, `w step ${i}`).toBeGreaterThanOrEqual(counts[i - 1]!);
    expect(counts[5]!).toBeGreaterThan(counts[0]! + 6);
    // fog lamps are a fine part (260 .. 400): not drawn at 200, drawn whole at 420 (a light circle pair)
    const fog = (w: number) => draw(car, "front", base({ w, lights: true })).filter((p) => p.k === "poly" && "color" in p && p.color === ND.headCore).length;
    expect(fog(420)).toBeGreaterThan(fog(200));
    // the medium parts are alpha-faded in, never a pop: a prim at w = 150 is part clear
    const mid = draw(look("sports", DART), "front", base({ w: 150 }));
    expect(mid.some((p) => alphaOf(p) < 0.99 && alphaOf(p) > 0.05)).toBe(true);
    expect(END_MEDIUM[0]).toBeLessThan(END_MEDIUM[1]);
    expect(END_FINE[0]).toBeGreaterThanOrEqual(END_MEDIUM[1]);
  });

  it("a part that has faded out is dropped by the pen: the splitter's dark blade is not in a far car", () => {
    const car = dart();
    const blade = (w: number) => draw(car, "front", base({ w })).filter((p) => p.k === "rect" && "color" in p && p.color === grade("#17181d", NIGHT)).length;
    expect(blade(24)).toBe(0);
    expect(blade(420)).toBe(1);
  });
});

describe("the lamps", () => {
  it("count by shape: pairs, bars and the split bar, from the same numbers the drawer uses", () => {
    const front: Record<(typeof FRONT_SHAPES)[number], number> = { round: 2, twin_round: 4, oval: 2, square: 2, rect: 2, slim: 2, swept: 2, angled: 2, stacked: 4, pop_up: 2, strip: 1 };
    for (const shape of FRONT_SHAPES) {
      const car = look("sedan", { v: 1, lights: { front: { shape } } });
      const l = endLamps(car, "front", 300, true);
      expect(l.polys.length, `front ${shape}`).toBe(front[shape]);
      expect(Number.isFinite(l.cx + l.cy + l.r)).toBe(true);
      // drawn: one lens shape in the lens colour
      expect(polysOf(draw(car, "front", base({ lights: true })), ND.headCore).length, `front ${shape} drawn`).toBe(1);
    }
    const rear: Record<(typeof REAR_SHAPES)[number], number> = { round: 2, twin_round: 4, square: 2, rect: 2, tall: 2, slim: 2, bar: 1, split_bar: 2, wedge: 2, c_shape: 2 };
    for (const shape of REAR_SHAPES) {
      const car = look("sedan", { v: 1, lights: { rear: { shape } } });
      const l = endLamps(car, "back", 300);
      expect(l.polys.length, `rear ${shape}`).toBe(rear[shape]);
      expect(l.bar, `bar ${shape}`).toBe(shape === "bar");
      expect(polysOf(draw(car, "back", base({ lights: true, braking: 1 })), ND.brakeCore).length, `rear ${shape} drawn`).toBe(1);
    }
  });

  it("every shape is a different drawing, and a lamp is sized by the body, not by the shot's width", () => {
    const seen = new Set<string>();
    for (const shape of FRONT_SHAPES) seen.add(JSON.stringify(endLamps(look("sedan", { v: 1, lights: { front: { shape } } }), "front", 300, true).polys.map((q) => q.map((v) => Math.round(v)))));
    expect(seen.size).toBe(FRONT_SHAPES.length);
    const rear = new Set<string>();
    for (const shape of REAR_SHAPES) rear.add(JSON.stringify(endLamps(look("sedan", { v: 1, lights: { rear: { shape } } }), "back", 300).polys.map((q) => q.map((v) => Math.round(v)))));
    expect(rear.size).toBe(REAR_SHAPES.length);
    // a wide body (the sports preset) has its lamps further out than a narrow one (the compact), against the same shot width
    const wide = endLamps(look("sports", { v: 1 }), "back", 300);
    const narrow = endLamps(look("compact", { v: 1 }), "back", 300);
    expect(wide.cx).toBeGreaterThan(narrow.cx);
    // and they stay on the body: inside half its width
    for (const body of WHEELED) {
      for (const view of ["front", "back"] as const) {
        const l = endLamps(look(body, { v: 1 }), view, 300);
        const half = (300 * (body === "bus" ? 1.14 : 1.1)) / 2;
        for (const q of l.polys) for (let i = 0; i < q.length; i += 2) expect(Math.abs(q[i]!), `${body} ${view}`).toBeLessThanOrEqual(half);
      }
    }
  });

  it("a pop-up lamp is a flap line by day and a raised block with the lights on", () => {
    const car = look("sports", { v: 1, lights: { front: { shape: "pop_up" } } });
    const off = endLamps(car, "front", 300, false).polys[0]!;
    const on = endLamps(car, "front", 300, true).polys[0]!;
    const h = (q: number[]) => Math.max(...q.filter((_, i) => i % 2 === 1)) - Math.min(...q.filter((_, i) => i % 2 === 1));
    expect(h(on)).toBeGreaterThan(h(off) * 2);
  });

  it("braking turns every rear lens brake red and nothing stays tail red", () => {
    for (const shape of REAR_SHAPES) {
      const car = look("sedan", { v: 1, lights: { rear: { shape } } });
      const braked = draw(car, "back", base({ braking: 1, lights: true }));
      expect(withColour(braked, ND.tailCore), shape).toEqual([]);
      expect(withColour(braked, ND.brakeCore).length, shape).toBeGreaterThanOrEqual(1);
      const tail = draw(car, "back", base({ braking: 0, lights: true }));
      expect(withColour(tail, ND.tailCore).length, shape).toBe(1);
      expect(withColour(tail, ND.brakeCore), shape).toEqual([]);
      const off = draw(car, "back", base({ braking: 0, lights: false, light: LIGHTS.day }));
      expect(withColour(off, ND.tailCore), shape).toEqual([]);
      expect(withColour(off, grade(TAIL_OFF, LIGHTS.day)).length, shape).toBeGreaterThanOrEqual(1);
    }
  });

  it("both light paths: night drive's soft glows, Bright's flat discs and no glow prim", () => {
    const car = dart();
    const o = base({ lights: true, braking: 1, blink: 1, bloom: 1.8 });
    const soft = draw(car, "back", o, "night_drive").concat(draw(car, "front", o, "night_drive"));
    const flat = draw(car, "back", o, "classic").concat(draw(car, "front", o, "classic"));
    expect(soft.filter((p) => p.k === "glow").length).toBeGreaterThanOrEqual(4);
    expect(flat.filter((p) => p.k === "glow")).toEqual([]);
    // the flat path still lights the lamps (a disc or an oval in the glow colours)
    expect(flat.some((p) => "color" in p && (p.color === ND.tailGlow || p.color === ND.headBloom))).toBe(true);
    // the lens itself is the same shape in both
    expect(withColour(flat, ND.brakeCore).length).toBe(withColour(soft, ND.brakeCore).length);
    // a bar tail light has one glow
    const bar = look("sedan", { v: 1, lights: { rear: { shape: "bar" } } });
    expect(draw(bar, "back", base({ lights: true })).filter((p) => p.k === "glow").length).toBe(1);
  });
});

describe("the back", () => {
  it("is the same for every face (a car with eyes shows none from behind)", () => {
    const faces: Expression[] = ["happy", "angry", "surprised", "sad"];
    for (const body of ["sedan", "sports"] as CarBody[]) {
      const detail = body === "sports" ? DART : { v: 1 as const };
      const plain = draw(look(body, detail), "back", base({ face: null, lights: true }));
      for (const eyes of ["windscreen", "headlights"] as const) {
        const car = look(body, detail, { face: { eyes, color: "#1c1842", mouth: "grille" } });
        for (const face of faces) expect(draw(car, "back", base({ face, lights: true })), `${body} ${eyes} ${face}`).toEqual(plain);
      }
    }
  });

  it("the plate is two plain rectangles and no mark is drawn", () => {
    for (const body of WHEELED) {
      const prims = draw(look(body), "back", base({ w: 420 }));
      expect(withColour(prims, grade(PLATE, NIGHT)).filter((p) => p.k === "rect").length, body).toBe(1);
      expect(withColour(prims, grade(PLATE, NIGHT)).filter((p) => p.k !== "rect"), body).toEqual([]);
      const rects = prims.filter((p) => p.k === "rect");
      expect(rects.some((p) => p.k === "rect" && p.color !== grade(PLATE, NIGHT) && p.w > 0 && Math.abs(p.x + p.w / 2 - 540) < 1 && p.w < 0.25 * 420), body).toBe(true);
    }
  });

  it("an open car from behind shows the screen beyond the cockpit, the hoops and the headrests; a closed one its rear window", () => {
    const open = draw(dart(), "back", base({ w: 420 }));
    const glass = grade(GLASS_ND.clear, NIGHT);
    // the screen is a darker glass than a closed car's window
    expect(withColour(open, glass)).toEqual([]);
    const closed = draw(look("sports", { ...DART, roof: { type: "closed" } }), "back", base({ w: 420 }));
    expect(withColour(closed, glass).length).toBe(1);
    // hoops and headrests: two more shapes in the open car than the same car without hoops
    const noHoops = draw(look("sports", { ...DART, roof: { type: "open", hoops: "none" } }), "back", base({ w: 420 }));
    expect(open.length).toBe(noHoops.length + 1);
  });

  it("a stripe runs over the deck, and over the roof only when the roof is closed", () => {
    const stripe = grade("#111111", NIGHT);
    const prims = (roof: "open" | "closed") => withColour(draw(look("sports", { ...DART, roof: { type: roof, hoops: "none" } }, { accent: "#111111" }), "back", base({ w: 420 })), stripe).filter((p) => p.k === "poly" && (p.pts.length ?? 0) >= 8);
    const open = prims("open")[0]!;
    const closed = prims("closed")[0]!;
    const top = (p: Prim) => Math.min(...(p as { pts: number[] }).pts.filter((_, i) => i % 2 === 1));
    expect(top(closed)).toBeLessThan(top(open) - 10);
  });
});

describe("one side showing", () => {
  it("side 0.8 moves one edge only: the near side stays, the far side grows", () => {
    const edge = (prims: Prim[]) => {
      const e = prims.filter((p) => p.k === "poly" || p.k === "rect").map(extent).filter((x): x is [number, number, number, number] => x !== null);
      return { left: Math.min(...e.map((x) => x[0])), right: Math.max(...e.map((x) => x[2])) };
    };
    for (const car of [look("sedan"), dart()]) {
      for (const v of ["back", "front"] as const) {
        const flat = edge(draw(car, v, base({ side: 0 })));
        const right = edge(draw(car, v, base({ side: 0.8 })));
        const left = edge(draw(car, v, base({ side: -0.8 })));
        expect(right.left, `${car.body} ${v} right: left edge`).toBeCloseTo(flat.left, 0);
        expect(right.right, `${car.body} ${v} right: right edge`).toBeGreaterThan(flat.right + 8);
        expect(left.right, `${car.body} ${v} left: right edge`).toBeCloseTo(flat.right, 0);
        expect(left.left, `${car.body} ${v} left: left edge`).toBeLessThan(flat.left - 8);
      }
    }
  });
});

describe("the likeness of the owner's kind of vehicle, head on and from behind", () => {
  it("has a black stripe down the middle, a blade splitter, a three part low mouth and swept lamps in front", () => {
    const prims = draw(dart(), "front", base({ w: 420, lights: true }));
    const stripe = withColour(prims, grade("#111111", NIGHT));
    expect(stripe.length).toBeGreaterThanOrEqual(1);
    expect(stripe.every((p) => p.k === "poly")).toBe(true);
    // the mouth: three parts joined into one dark polygon
    const mouth = withColour(prims, grade("#2a2d36", NIGHT)).filter((p) => p.k === "poly");
    expect(mouth.length).toBe(1);
    // the lamps are shaped by the look: a lit lens polygon that is not a circle or a rectangle (a teardrop's many points)
    const lens = withColour(prims, ND.headCore).filter((p): p is Extract<Prim, { k: "poly" }> => p.k === "poly");
    // the lens, and the daytime line under it
    expect(lens.length).toBe(2);
    expect(Math.max(...lens.map((p) => p.pts.length))).toBeGreaterThan(40);
  });

  it("has two round lamps set wide and high, two exhausts by the plate, a finned diffuser and no roof from behind", () => {
    const l = endLamps(dart(), "back", 420);
    expect(l.polys.length).toBe(2);
    expect(l.cx).toBeGreaterThan(0.3 * 420);
    const prims = draw(dart(), "back", base({ w: 420 }));
    // two exhaust rings in one joined shape (metal) and their dark mouths in another
    expect(withColour(prims, grade("#8f949c", NIGHT)).length).toBe(1);
    expect(withColour(prims, "#0c0b10").length).toBe(1);
    // the diffuser's fins
    expect(withColour(prims, grade("#4a4e57", NIGHT)).length).toBe(1);
  });
});
